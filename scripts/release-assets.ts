/**
 * What a release is made of, and whether a draft already carries it.
 *
 * A release used to be two files — the npm tarball and the manifest naming it —
 * and `draft-release` reconciled exactly those two by name. It now carries the
 * bundle the managed package channels install and the two installer scripts, so
 * the same question has to be asked of a set that changes between versions.
 *
 * Pure on purpose: the rule that decides whether to leave published bytes alone
 * or refuse the release outright is the one part of this that must not be
 * discovered to be wrong during a release.
 */

/** Name of the manifest asset, which cannot record a digest of itself. */
export const MANIFEST_ASSET = 'release-manifest.json'

export interface AssetDigest {
  bytes: number
  sha256: string
  /** Only the npm tarball has one; it is what the registry stores. */
  integrity?: string
}

export interface ReleaseManifest {
  name: string
  version: string
  commit: string | null
  /** The npm tarball. Kept at the top level, where every existing reader looks. */
  tarball: string
  bytes: number
  sha256: string
  integrity: string
  /** The floor an installer checks before installing. Absent in older manifests. */
  engines?: Record<string, string>
  /** Every attached asset by name, the tarball included. Absent in older manifests. */
  assets?: Record<string, AssetDigest>
}

/**
 * Every asset with a recorded digest.
 *
 * A manifest predating the `assets` map still describes one asset — the tarball,
 * at the top level — and has to keep working: `container-republish` reads
 * manifests from releases already published, and a repair of one of those must
 * not start failing because a later release changed the shape.
 */
export function digestedAssets(manifest: ReleaseManifest): Record<string, AssetDigest> {
  if (manifest.assets && Object.keys(manifest.assets).length > 0) return manifest.assets

  return {
    [manifest.tarball]: { bytes: manifest.bytes, sha256: manifest.sha256, integrity: manifest.integrity },
  }
}

/** Everything that must be attached, including the manifest itself. */
export function requiredAssets(manifest: ReleaseManifest): string[] {
  return [MANIFEST_ASSET, ...Object.keys(digestedAssets(manifest))].sort()
}

export type DraftPlan =
  | { action: 'upload'; missing: string[] }
  | { action: 'leave' }
  | { action: 'stop'; problems: string[] }

/**
 * What to do with a draft that already exists.
 *
 * All present or none: a resume is exactly the state where an upload got
 * partway, so one asset being there is no evidence about the others. Anything
 * present but different is a hard stop rather than a clobber — a rebuild of an
 * identical tree is byte-identical, so different bytes mean the tree changed
 * under a version that is already partly released, and replacing them would
 * either overwrite what somebody has already downloaded or make the attached
 * files disagree with what npm has.
 */
export function planDraftAssets(
  manifest: ReleaseManifest,
  present: string[],
  attached: Record<string, AssetDigest>,
): DraftPlan {
  const required = requiredAssets(manifest)
  const missing = required.filter((name) => !present.includes(name))
  if (missing.length > 0) return { action: 'upload', missing }

  const problems: string[] = []
  for (const [name, expected] of Object.entries(digestedAssets(manifest))) {
    const found = attached[name]
    if (!found) {
      problems.push(`${name}: attached to the draft but could not be read back`)
      continue
    }
    if (found.bytes !== expected.bytes) {
      problems.push(`${name}: draft has ${found.bytes} bytes, this build produced ${expected.bytes}`)
    }
    if (found.sha256 !== expected.sha256) {
      problems.push(`${name}: draft has sha256 ${found.sha256}, this build produced ${expected.sha256}`)
    }
  }

  return problems.length > 0 ? { action: 'stop', problems } : { action: 'leave' }
}

const COMPARED_FIELDS = ['version', 'tarball', 'bytes', 'sha256', 'integrity', 'commit'] as const

/**
 * Two manifests, field by field.
 *
 * A manifest agreeing on the hash but naming another version or another commit
 * is not this release's manifest, so the hash alone is not the comparison.
 */
export function manifestDifferences(built: ReleaseManifest, drafted: ReleaseManifest): string[] {
  const differences = COMPARED_FIELDS
    .filter((field) => String(built[field]) !== String(drafted[field]))
    .map((field) => `${field}: draft has ${String(drafted[field])}, this build produced ${String(built[field])}`)

  const builtAssets = digestedAssets(built)
  const draftedAssets = digestedAssets(drafted)

  for (const name of Object.keys(builtAssets)) {
    if (!(name in draftedAssets)) differences.push(`assets: the drafted manifest does not list ${name}`)
  }
  for (const name of Object.keys(draftedAssets)) {
    if (!(name in builtAssets)) differences.push(`assets: the drafted manifest lists ${name}, which this build did not produce`)
  }
  for (const [name, expected] of Object.entries(builtAssets)) {
    const found = draftedAssets[name]
    if (found && found.sha256 !== expected.sha256) {
      differences.push(`assets.${name}.sha256: draft has ${found.sha256}, this build produced ${expected.sha256}`)
    }
  }

  return differences
}
