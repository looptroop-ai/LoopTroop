/**
 * Decides where a release stands, purely from facts a workflow can observe.
 *
 * Every job must start from the same map of the world, or a partially completed
 * release means something different to the job that resumes it than it did to
 * the job that stopped. This module is that map: the resolution is a pure
 * function of `ReleaseFacts`, which the `detect` job assembles by asking git,
 * the GitHub API and the npm registry.
 *
 * The rule that shapes everything here is that a tag must never on its own mean
 * "done". Publishing a release is several irreversible operations in a row, and
 * a tag pushed before the last of them would make a half-finished release
 * indistinguishable from a finished one — so the tag is written last, and
 * "complete" is the conjunction of every channel rather than any one marker.
 */

/** What the release workflow can observe about one version. */
export interface ReleaseFacts {
  /** Version under release, e.g. `0.5.0` or `0.5.0-rc.1`. */
  version: string
  /** The version in package.json at the commit being released. */
  manifestVersion: string
  /** Whether this push is what changed the version. */
  versionChangedInPush: boolean
  /** Full SHA of the commit the release is cut from. */
  targetSha: string
  /** Full SHA the tag resolves to, or null when no tag exists. */
  tagSha: string | null
  /** Whether a Release exists for this version, draft or published. */
  releaseExists: boolean
  /** Whether that Release is still a draft. */
  releaseIsDraft: boolean
  /** npm's `dist.integrity` for this version, or null when unpublished. */
  npmIntegrity: string | null
  /**
   * The integrity this build produced, or null when it is not yet known.
   *
   * The `detect` job runs before the build, so at classification time there are
   * no bytes to compare against. Null means "defer the byte comparison", not
   * "the bytes are fine": the npm job re-reads npm's own `dist.integrity` after
   * publishing and fails the release on a mismatch, which is the same gate one
   * stage later and with the artefact actually in hand.
   */
  expectedIntegrity: string | null
  /** The dist-tag this version must publish under: `latest` or `next`. */
  expectedDistTag: string
  /** npm's dist-tags, or null when the package resolves nothing. */
  npmDistTags: Record<string, string> | null
}

export type ReleaseStateName =
  | 'skip'
  | 'fresh'
  | 'resume-npm'
  | 'resume-github'
  | 'complete'
  | 'unverified'
  | 'conflict'

export interface ReleaseStateResult {
  state: ReleaseStateName
  reason: string
  /** False for the two states a workflow must never try to heal past. */
  safeToContinue: boolean
}

export const INTEGRITY_MISMATCH = 'published bytes differ from this build'
export const TAG_COMMIT_MISMATCH = 'tag points at a different commit'

/** Whether the version carries the dist-tag it is supposed to. */
export function hasCorrectDistTag(facts: ReleaseFacts): boolean {
  return facts.npmDistTags?.[facts.expectedDistTag] === facts.version
}

/**
 * Whether publishing a release candidate moved `latest`.
 *
 * npm tags a publish `latest` unless given `--tag`; it infers nothing from
 * `-rc.N`. A candidate that took `latest` is what everyone installing the
 * package would now get, so it is a defect to catch rather than to resume past.
 */
export function prereleaseTookLatest(facts: ReleaseFacts): boolean {
  return facts.expectedDistTag !== 'latest' && facts.npmDistTags?.latest === facts.version
}

/**
 * Names what a partial release has already produced.
 *
 * A resume reason that overstates this is worse than one that says nothing: it
 * is read by whoever is deciding whether to let the run continue, and "a Release
 * exists" when only a tag does sends them looking for something that is not
 * there.
 */
function describeExisting(facts: ReleaseFacts, tagOnTarget: boolean): string {
  const present: string[] = []
  if (tagOnTarget) present.push('the tag is in place')
  if (facts.releaseExists) present.push(facts.releaseIsDraft ? 'a draft Release exists' : 'a published Release exists')
  return present.length > 0 ? present.join(', ') : 'nothing else exists for it either'
}

export function resolveReleaseState(facts: ReleaseFacts): ReleaseStateResult {
  const tagExists = facts.tagSha !== null
  const tagOnTarget = tagExists && facts.tagSha!.toLowerCase() === facts.targetSha.toLowerCase()
  const onNpm = facts.npmIntegrity !== null
  // Whether the byte comparison can be made at all. See `expectedIntegrity`:
  // when the build has not run yet there is nothing to compare, and the
  // comparison is deferred rather than assumed either way.
  const bytesComparable = facts.expectedIntegrity !== null
  const integrityMatches = onNpm && bytesComparable && facts.npmIntegrity === facts.expectedIntegrity

  const tagAndRelease = tagOnTarget && facts.releaseExists && !facts.releaseIsDraft
  const tagAndDraft = tagOnTarget && facts.releaseExists && facts.releaseIsDraft
  const distTagCorrect = hasCorrectDistTag(facts)
  const publishedCorrectly = onNpm && integrityMatches && distTagCorrect

  // ---- Everything shipped, and the bytes on npm are the bytes this build
  // produced. Checked first so a re-run over a finished release reports that it
  // is finished rather than that nothing changed.
  if (tagAndRelease && publishedCorrectly) {
    return {
      state: 'complete',
      safeToContinue: true,
      reason:
        `v${facts.version} is tagged at ${facts.targetSha}, published on GitHub, and on npm `
        + `under "${facts.expectedDistTag}" with matching integrity.`,
    }
  }

  // ---- Everything shipped except the byte comparison, which cannot be made
  // from here.
  //
  // This is what a re-run over an already-finished release looks like: the tag
  // is on this commit, the Release is published, npm has the version under the
  // right dist-tag — but `detect` runs before the build, so there is no
  // `--expected-integrity` to compare against. "No bytes to compare" is not
  // "the bytes are fine", so this is not `complete`.
  //
  // The state is load-bearing rather than cosmetic. Without it a re-run on the
  // release commit falls through every branch below to `resume-npm`, which
  // would send a finished release back to the publish job.
  if (tagAndRelease && onNpm && distTagCorrect && !bytesComparable) {
    return {
      state: 'unverified',
      safeToContinue: true,
      reason:
        `v${facts.version} is tagged at ${facts.targetSha}, published on GitHub, and on npm under `
        + `"${facts.expectedDistTag}" — every channel is done, so there is nothing to publish. `
        + 'The bytes were not compared: this ran before any build, so there was no integrity to '
        + 'compare against. The publishing run already made that comparison against the registry. '
        + 'To repeat it, rebuild the tag and re-run detection with the resulting '
        + '--expected-integrity.',
    }
  }

  // ---- Not a release at all.
  //
  // This is checked *before* the hard stops, because every hard stop below is a
  // statement about a release this push is trying to cut. After any release, the
  // tag stays where it was while main moves on, so from the next commit onwards
  // "a tag for the version in package.json exists at a different commit" is the
  // ordinary, healthy state of the repository — and reading it as damage would
  // hard-stop the workflow on every subsequent push to main.
  //
  // It is also what grandfathers the pre-automation history: GitHub carries
  // releases this workflow never cut, while npm carries only the placeholder
  // first publish, and neither absence is damage to repair.
  if (!facts.versionChangedInPush) {
    return {
      state: 'skip',
      safeToContinue: true,
      reason:
        `This push did not change the version — package.json still carries ${facts.manifestVersion}. `
        + 'Releases are cut by merging a release pull request, so there is nothing to do here.',
    }
  }

  // ---- Hard stops. This push *is* trying to release this version, and
  // something happened outside this workflow. Every recovery path from here
  // would paper over it rather than repair it.

  if (tagExists && !tagOnTarget) {
    return {
      state: 'conflict',
      safeToContinue: false,
      reason:
        `Hard stop: ${TAG_COMMIT_MISMATCH}. v${facts.version} resolves to ${facts.tagSha}, `
        + `but this release is cut from ${facts.targetSha}. Investigate before retrying — `
        + 'a retry would publish one commit under a tag that names another.',
    }
  }

  if (onNpm && bytesComparable && !integrityMatches) {
    return {
      state: 'conflict',
      safeToContinue: false,
      reason:
        `Hard stop: ${INTEGRITY_MISMATCH}. npm holds ${facts.npmIntegrity} for ${facts.version}, `
        + `this build produced ${facts.expectedIntegrity}. npm versions are immutable, so this `
        + 'cannot be corrected by republishing. Release a new version instead.',
    }
  }

  if (prereleaseTookLatest(facts)) {
    return {
      state: 'conflict',
      safeToContinue: false,
      reason:
        `Hard stop: release candidate ${facts.version} holds the "latest" dist-tag, so it is what `
        + 'a plain `npm i -g looptroop` installs. Move "latest" back to the newest stable release '
        + 'with `npm dist-tag add` before releasing anything else.',
    }
  }

  // ---- Recovery. The version changed, so a release is wanted, and one or more
  // channels are behind.

  if (!facts.releaseExists && !tagExists && !onNpm) {
    return {
      state: 'fresh',
      safeToContinue: true,
      reason: `Nothing exists for v${facts.version} yet. Releasing from the start.`,
    }
  }

  if (onNpm && bytesComparable && !distTagCorrect) {
    return {
      state: 'conflict',
      safeToContinue: false,
      reason:
        `Hard stop: npm carries ${facts.version} under "${facts.expectedDistTag}" at ${facts.npmIntegrity}, `
        + 'which matches this build, but the dist-tag does not resolve to this version. '
        + 'Move it with `npm dist-tag add looptroop@VERSION TAG` — a workflow cannot repair a '
        + 'dist-tag it did not break, and retrying would publish nothing new.',
    }
  }

  if (publishedCorrectly) {
    return {
      state: 'resume-github',
      safeToContinue: true,
      reason:
        `npm already carries ${facts.version} under "${facts.expectedDistTag}" with matching integrity. `
        + `${tagAndDraft ? 'The tag is in place; the Release is still a draft.' : 'The tag has not been pushed yet.'} `
        + 'Continuing on the GitHub side only.',
    }
  }

  // A tag on the release commit does not shorten the work when npm is behind.
  // Only `publishedCorrectly` above may skip the publish job; everything that
  // reaches here still has bytes to ship, whatever else is already in place.
  return {
    state: 'resume-npm',
    safeToContinue: true,
    reason: onNpm
      ? `npm has ${facts.version}, but not under "${facts.expectedDistTag}" with bytes this run can vouch for. `
        + 'Continuing to the publish job, which re-reads the registry with the built artefact in hand '
        + 'and fails there if the bytes or the dist-tag are wrong. It does not move dist-tags.'
      : `npm does not have v${facts.version} yet (${describeExisting(facts, tagOnTarget)}). `
        + 'Continuing from the publish step.',
  }
}
