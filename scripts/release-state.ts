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

export function resolveReleaseState(facts: ReleaseFacts): ReleaseStateResult {
  const tagExists = facts.tagSha !== null
  const tagOnTarget = tagExists && facts.tagSha!.toLowerCase() === facts.targetSha.toLowerCase()
  const onNpm = facts.npmIntegrity !== null
  // Whether the byte comparison can be made at all. See `expectedIntegrity`:
  // when the build has not run yet there is nothing to compare, and the
  // comparison is deferred rather than assumed either way.
  const bytesComparable = facts.expectedIntegrity !== null
  const integrityMatches = onNpm && bytesComparable && facts.npmIntegrity === facts.expectedIntegrity

  // `publishedCorrectly` deliberately accepts an unverifiable integrity: with
  // the build yet to run, requiring a byte match would classify every finished
  // release as needing an npm publish it does not need. The dist-tag conjunct
  // still binds, and the byte comparison happens in the npm job.
  const publishedCorrectly = onNpm && (!bytesComparable || integrityMatches) && hasCorrectDistTag(facts)
  const releasePublished = facts.releaseExists && !facts.releaseIsDraft

  // ---- Everything shipped. Checked first so a re-run over a finished release
  // reports that it is finished rather than that nothing changed.

  if (tagOnTarget && releasePublished && publishedCorrectly) {
    return {
      state: 'complete',
      safeToContinue: true,
      reason: `v${facts.version} is tagged at ${facts.targetSha}, published on GitHub, and on npm under "${facts.expectedDistTag}".`,
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
  // releases back to v0.4.1 while npm carries only the 0.0.0 placeholder.
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

  if (publishedCorrectly) {
    return {
      state: 'resume-github',
      safeToContinue: true,
      reason:
        `npm already carries ${facts.version} under "${facts.expectedDistTag}"`
        + `${integrityMatches ? ' with matching integrity' : ''}. `
        + `${tagOnTarget ? 'The tag is in place; the Release is still a draft.' : 'The tag has not been pushed yet.'} `
        + 'Continuing on the GitHub side only.',
    }
  }

  return {
    state: 'resume-npm',
    safeToContinue: true,
    reason: onNpm
      ? `npm has ${facts.version} but under the wrong dist-tag. Correcting the tag and finishing.`
      : `A Release exists for v${facts.version} but npm does not have it yet. Continuing from the publish step.`,
  }
}
