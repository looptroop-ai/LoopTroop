import { describe, it, expect } from 'vitest'
import {
  digestedAssets,
  manifestDifferences,
  MANIFEST_ASSET,
  planDraftAssets,
  requiredAssets,
  type ReleaseManifest,
} from '../scripts/release-assets.ts'

const TARBALL = 'looptroop-9.9.9.tgz'
const BUNDLE = 'looptroop-9.9.9-bundle.tar.gz'

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    name: 'looptroop',
    version: '9.9.9',
    commit: 'a'.repeat(40),
    tarball: TARBALL,
    bytes: 100,
    sha256: 'aa',
    integrity: 'sha512-AA',
    assets: {
      [TARBALL]: { bytes: 100, sha256: 'aa', integrity: 'sha512-AA' },
      [BUNDLE]: { bytes: 200, sha256: 'bb' },
      'install.sh': { bytes: 300, sha256: 'cc' },
      'install.ps1': { bytes: 400, sha256: 'dd' },
    },
    ...overrides,
  }
}

/** What was attached, keyed the way the driver hands hashes back. */
function attachedFrom(source: ReleaseManifest) {
  return { ...digestedAssets(source) }
}

describe('what a release is made of', () => {
  it('lists every asset that must be attached, the manifest included', () => {
    expect(requiredAssets(manifest())).toEqual(
      ['install.ps1', 'install.sh', BUNDLE, TARBALL, MANIFEST_ASSET].sort(),
    )
  })

  /**
   * `container-republish` reads the manifest attached to a release published
   * before the `assets` map existed. If that stopped describing an asset set,
   * repairing an already-published release would break.
   */
  it('reads an older manifest that has only the top-level tarball fields', () => {
    const old = manifest({ assets: undefined })

    expect(digestedAssets(old)).toEqual({ [TARBALL]: { bytes: 100, sha256: 'aa', integrity: 'sha512-AA' } })
    expect(requiredAssets(old)).toEqual([MANIFEST_ASSET, TARBALL].sort())
  })

  it('treats an empty assets map as the old shape rather than as no assets', () => {
    expect(Object.keys(digestedAssets(manifest({ assets: {} })))).toEqual([TARBALL])
  })
})

describe('reconciling a draft that already exists', () => {
  it('leaves assets alone when every one of them matches', () => {
    const built = manifest()

    expect(planDraftAssets(built, requiredAssets(built), attachedFrom(built))).toEqual({ action: 'leave' })
  })

  /**
   * A resume is exactly the state where an upload got partway, so one asset
   * being present is no evidence about the others.
   */
  it('re-uploads everything when any single asset is missing', () => {
    const built = manifest()
    const present = requiredAssets(built).filter((name) => name !== BUNDLE)

    expect(planDraftAssets(built, present, attachedFrom(built))).toEqual({ action: 'upload', missing: [BUNDLE] })
  })

  it('re-uploads when only the manifest is there', () => {
    const built = manifest()
    const plan = planDraftAssets(built, [MANIFEST_ASSET], attachedFrom(built))

    expect(plan.action).toBe('upload')
  })

  /**
   * A rebuild of an identical tree is byte-identical, so different bytes mean
   * the tree changed under a version that is already partly released.
   * Clobbering would replace something a user may already have downloaded, or
   * make the attached file disagree with what npm has.
   */
  it('stops rather than clobbering an asset whose bytes differ', () => {
    const built = manifest()
    const attached = { ...attachedFrom(built), [BUNDLE]: { bytes: 200, sha256: 'different' } }

    const plan = planDraftAssets(built, requiredAssets(built), attached)

    expect(plan.action).toBe('stop')
    expect(plan).toMatchObject({ problems: [expect.stringContaining(BUNDLE)] })
  })

  it('stops when a size differs even if nothing else does', () => {
    const built = manifest()
    const attached = { ...attachedFrom(built), 'install.sh': { bytes: 999, sha256: 'cc' } }

    expect(planDraftAssets(built, requiredAssets(built), attached).action).toBe('stop')
  })

  it('stops when an attached asset could not be read back', () => {
    const built = manifest()
    const attached = attachedFrom(built)
    delete attached[BUNDLE]

    expect(planDraftAssets(built, requiredAssets(built), attached).action).toBe('stop')
  })

  it('ignores extra assets nobody asked about', () => {
    const built = manifest()
    const present = [...requiredAssets(built), 'notes.txt']

    expect(planDraftAssets(built, present, attachedFrom(built))).toEqual({ action: 'leave' })
  })
})

describe('comparing a drafted manifest against this build', () => {
  it('finds nothing to say about two identical manifests', () => {
    expect(manifestDifferences(manifest(), manifest())).toEqual([])
  })

  /** A manifest agreeing on the hash but naming another commit is not this one. */
  it('reports a differing commit even when every hash matches', () => {
    const differences = manifestDifferences(manifest(), manifest({ commit: 'b'.repeat(40) }))

    expect(differences).toEqual([expect.stringContaining('commit')])
  })

  it('reports an asset the draft is missing from its map', () => {
    const drafted = manifest()
    delete drafted.assets![BUNDLE]

    expect(manifestDifferences(manifest(), drafted)).toEqual([expect.stringContaining(BUNDLE)])
  })

  it('reports an asset the draft lists that this build did not produce', () => {
    const drafted = manifest()
    drafted.assets!['looptroop-9.9.9.msi'] = { bytes: 1, sha256: 'ee' }

    expect(manifestDifferences(manifest(), drafted)).toEqual([expect.stringContaining('.msi')])
  })

  it('reports a per-asset hash difference', () => {
    const drafted = manifest()
    drafted.assets!['install.ps1'] = { bytes: 400, sha256: 'changed' }

    expect(manifestDifferences(manifest(), drafted)).toEqual([expect.stringContaining('assets.install.ps1.sha256')])
  })

  it('compares an older manifest against a new one on the fields both have', () => {
    // The upgrade release is the one case where a drafted manifest legitimately
    // predates the shape: it must be reported as different, not crash.
    const differences = manifestDifferences(manifest(), manifest({ assets: undefined }))

    expect(differences.length).toBeGreaterThan(0)
  })
})
