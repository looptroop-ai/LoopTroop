import { describe, expect, it } from 'vitest'
import {
  type ReleaseFacts,
  hasCorrectDistTag,
  resolveReleaseState,
} from '../scripts/release-state'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const INTEGRITY = 'sha512-base64abc123=='

function facts(overrides: Partial<ReleaseFacts>): ReleaseFacts {
  return {
    version: '0.5.0',
    manifestVersion: '0.5.0',
    versionChangedInPush: true,
    targetSha: SHA,
    tagSha: null,
    releaseExists: false,
    releaseIsDraft: false,
    npmIntegrity: null,
    expectedIntegrity: INTEGRITY,
    expectedDistTag: 'latest',
    npmDistTags: null,
    ...overrides,
  }
}

const published = {
  tagSha: SHA,
  releaseExists: true,
  releaseIsDraft: false,
  npmIntegrity: INTEGRITY,
  npmDistTags: { latest: '0.5.0', next: '0.4.1' },
} as const

describe('resolveReleaseState', () => {
  it('reports fresh when nothing exists and the version changed', () => {
    const result = resolveReleaseState(facts({}))
    expect(result.state).toBe('fresh')
    expect(result.safeToContinue).toBe(true)
  })

  it('resumes from npm when a draft exists and npm is empty', () => {
    const result = resolveReleaseState(facts({
      releaseExists: true,
      releaseIsDraft: true,
    }))
    expect(result.state).toBe('resume-npm')
  })

  it('resumes from GitHub when npm is right but the tag is missing', () => {
    const result = resolveReleaseState(facts({
      releaseExists: true,
      releaseIsDraft: false,
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.5.0', next: '0.4.1' },
    }))
    expect(result.state).toBe('resume-github')
  })

  it('resumes from GitHub when npm is right but the Release is still a draft', () => {
    const result = resolveReleaseState(facts({
      ...published,
      releaseIsDraft: true,
    }))
    expect(result.state).toBe('resume-github')
  })

  it('is complete when every channel agrees', () => {
    const result = resolveReleaseState(facts(published))
    expect(result.state).toBe('complete')
  })

  // The single load-bearing property of the whole design: the tag is written
  // last, so a tag in place must not mean the release is done.
  it('is never complete on a tag alone', () => {
    const result = resolveReleaseState(facts({ tagSha: SHA }))
    expect(result.state).not.toBe('complete')
  })

  it('hard-stops when the tag points at a different commit', () => {
    const result = resolveReleaseState(facts({ tagSha: OTHER_SHA }))
    expect(result.state).toBe('conflict')
    expect(result.safeToContinue).toBe(false)
    expect(result.reason).toMatch(/different commit/)
  })

  it('hard-stops when npm holds different bytes', () => {
    const result = resolveReleaseState(facts({
      tagSha: SHA,
      releaseExists: true,
      releaseIsDraft: false,
      npmIntegrity: 'sha512-different==',
      npmDistTags: { latest: '0.5.0' },
    }))
    expect(result.state).toBe('conflict')
    expect(result.safeToContinue).toBe(false)
    expect(result.reason).toMatch(/published bytes differ/)
  })

  // Everything is in place except the dist-tag, so `complete` would be a lie —
  // `npm i -g looptroop` does not get this version. It is not resumable either:
  // the bytes are already on npm under an immutable version, so the publish job
  // has nothing to do, and this workflow deliberately never moves a dist-tag it
  // did not set. Someone has to move it.
  it('is not complete when integrity matches but the dist-tag is wrong', () => {
    const result = resolveReleaseState(facts({
      tagSha: SHA,
      releaseExists: true,
      releaseIsDraft: false,
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.4.1' },
    }))
    expect(result.state).toBe('conflict')
    expect(result.safeToContinue).toBe(false)
    expect(result.reason).toMatch(/dist-tag add/)
  })

  it('hard-stops when a release candidate took the latest dist-tag', () => {
    const result = resolveReleaseState(facts({
      version: '0.5.0-rc.1',
      manifestVersion: '0.5.0-rc.1',
      expectedDistTag: 'next',
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.5.0-rc.1', next: '0.5.0-rc.1' },
    }))
    expect(result.state).toBe('conflict')
    expect(result.safeToContinue).toBe(false)
  })

  it('is not complete when the version has not changed in this push', () => {
    const result = resolveReleaseState(facts({ versionChangedInPush: false }))
    expect(result.state).toBe('skip')
  })

  // GitHub carries releases back to v0.4.1 while npm carries only 0.0.0, so a
  // re-run over that history must be a no-op, not a repair of something broken.
  it('skips a pre-automation version that this push did not change', () => {
    const result = resolveReleaseState(facts({
      version: '0.4.1',
      manifestVersion: '0.4.1',
      versionChangedInPush: false,
      tagSha: SHA,
      releaseExists: true,
      releaseIsDraft: false,
    }))
    expect(result.state).toBe('skip')
  })

  // npm versions are immutable, so the bytes being right and the dist-tag being
  // wrong is not something a re-run can repair: there is nothing left to
  // publish, and this workflow never moves a dist-tag it did not set. Resuming
  // would run the publish job for a version already on the registry and then
  // report success without the tag having moved.
  it('hard stops when the bytes are right but the dist-tag is not', () => {
    const result = resolveReleaseState(facts({
      releaseExists: true,
      releaseIsDraft: true,
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.4.1' },
    }))
    expect(result.state).toBe('conflict')
    expect(result.safeToContinue).toBe(false)
    expect(result.reason).toMatch(/dist-tag/)
  })

  // Same shape, but the bytes on npm are not this build's. That is the older,
  // more serious hard stop and it must win: reporting the dist-tag would send
  // someone to move a tag onto bytes nobody verified.
  it('prefers the integrity conflict over the dist-tag one', () => {
    const result = resolveReleaseState(facts({
      releaseExists: true,
      releaseIsDraft: true,
      npmIntegrity: 'sha512-bytesThisBuildDidNotProduce',
      npmDistTags: { latest: '0.4.1' },
    }))
    expect(result.state).toBe('conflict')
    expect(result.reason).toMatch(/published bytes differ/)
  })

  // The state every push to main lands in once a release has been cut: the tag
  // stays at the release commit while main moves on, so a tag for the version
  // in package.json legitimately points somewhere other than HEAD. Read as a
  // conflict, this would hard-stop the workflow on every subsequent push.
  it('skips an ordinary push whose tag sits on an earlier commit', () => {
    const result = resolveReleaseState(facts({
      version: '0.4.1',
      manifestVersion: '0.4.1',
      versionChangedInPush: false,
      tagSha: OTHER_SHA,
      targetSha: SHA,
      releaseExists: true,
      releaseIsDraft: false,
    }))
    expect(result.state).toBe('skip')
  })

  // Same facts, but this push is what changed the version — now the mismatch
  // means the release is genuinely cut from a commit the tag does not name.
  it('hard stops on the same tag mismatch when the version did change', () => {
    const result = resolveReleaseState(facts({
      versionChangedInPush: true,
      tagSha: OTHER_SHA,
      targetSha: SHA,
    }))
    expect(result.state).toBe('conflict')
    expect(result.safeToContinue).toBe(false)
  })

  it('does not resurrect a stale published version as a conflict', () => {
    const result = resolveReleaseState(facts({
      version: '0.4.1',
      manifestVersion: '0.4.1',
      versionChangedInPush: false,
      npmIntegrity: 'sha512-somethingElseEntirely',
      npmDistTags: { latest: '0.4.1' },
    }))
    expect(result.state).toBe('skip')
  })
})

// `detect` runs before the build, so it has no artefact to compare against.
// Null must mean "defer", never "assume mismatch" (which would hard-stop every
// resumed release) and never "assume match" (which would let a substituted
// artefact through). The byte check moves to the npm job; the dist-tag conjunct
// still binds here.
describe('resolveReleaseState with the build integrity not yet known', () => {
  // Every channel is done, but nothing here compared the bytes. `complete` would
  // claim a verification that did not happen; `resume-npm` would send a finished
  // release back to the publish job. `unverified` is neither, and it does not
  // proceed.
  it('reports a finished release as unverified rather than complete or resumable', () => {
    const result = resolveReleaseState(facts({
      expectedIntegrity: null,
      tagSha: SHA,
      releaseExists: true,
      releaseIsDraft: false,
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.5.0' },
    }))
    expect(result.state).toBe('unverified')
    expect(result.safeToContinue).toBe(true)
    expect(result.reason).toMatch(/nothing to publish/)
  })

  // The same facts plus the bytes. Only a run holding the artefact may say a
  // release is finished and verified.
  it('is complete once the same facts include the build integrity', () => {
    const result = resolveReleaseState(facts({
      expectedIntegrity: INTEGRITY,
      tagSha: SHA,
      releaseExists: true,
      releaseIsDraft: false,
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.5.0' },
    }))
    expect(result.state).toBe('complete')
  })

  // `unverified` requires the tag to name *this* commit, which is what keeps it
  // from swallowing the ordinary post-release push: main moves on, the tag stays
  // put, and that push must still read as `skip`.
  it('still skips an ordinary push once main has moved past the tag', () => {
    const result = resolveReleaseState(facts({
      expectedIntegrity: null,
      versionChangedInPush: false,
      tagSha: OTHER_SHA,
      targetSha: SHA,
      releaseExists: true,
      releaseIsDraft: false,
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.5.0' },
    }))
    expect(result.state).toBe('skip')
  })

  it('never hard stops on integrity it cannot compare', () => {
    const result = resolveReleaseState(facts({
      expectedIntegrity: null,
      releaseExists: true,
      releaseIsDraft: true,
      npmIntegrity: 'sha512-bytesThisBuildDidNotProduce',
      npmDistTags: { latest: '0.5.0' },
    }))
    expect(result.state).not.toBe('conflict')
  })

  it('still requires the dist-tag to be right', () => {
    const result = resolveReleaseState(facts({
      expectedIntegrity: null,
      releaseExists: true,
      releaseIsDraft: true,
      npmIntegrity: INTEGRITY,
      npmDistTags: { latest: '0.4.1' },
    }))
    expect(result.state).toBe('resume-npm')
  })

  it('hard stops on a mismatch once the integrity is known', () => {
    const result = resolveReleaseState(facts({
      expectedIntegrity: INTEGRITY,
      releaseExists: true,
      releaseIsDraft: true,
      npmIntegrity: 'sha512-bytesThisBuildDidNotProduce',
      npmDistTags: { latest: '0.5.0' },
    }))
    expect(result.state).toBe('conflict')
    expect(result.safeToContinue).toBe(false)
  })
})

describe('hasCorrectDistTag', () => {
  it('is true when the expected tag names the version', () => {
    expect(hasCorrectDistTag(facts({ npmDistTags: { latest: '0.5.0' } }))).toBe(true)
  })

  it('is false when the expected tag names something else', () => {
    expect(hasCorrectDistTag(facts({ npmDistTags: { latest: '0.4.1' } }))).toBe(false)
  })

  it('is false when the registry knows nothing', () => {
    expect(hasCorrectDistTag(facts({ npmDistTags: null }))).toBe(false)
  })
})
