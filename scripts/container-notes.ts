/**
 * The container section of a release's notes, and how it is spliced in.
 *
 * Pure text, no `gh`, no network: the release run and the repair dispatch both
 * write this block, and the interesting behaviour — replacing an existing block
 * instead of appending a second one, and refusing to guess when someone has
 * edited inside it — is worth testing without a GitHub Release to point at.
 *
 * The driver is ./release-container-notes.ts.
 */

/** Everything between these is this block's territory. Everything outside them
 * is left exactly as the changelog rendered it. */
export const START = '<!-- container:start -->'
export const END = '<!-- container:end -->'

export interface ContainerBlockInput {
  version: string
  /** The multi-architecture index both registries serve for this version. */
  indexDigest: string
  /** As a user types it: Docker Hub's implicit `docker.io/` host removed. */
  dhRef: string
  ghcrRef: string
}

export function containerBlock(input: ContainerBlockInput): string {
  const { version, indexDigest, dhRef, ghcrRef } = input
  return [
    START,
    '### Container image',
    '',
    '```',
    `docker pull ${dhRef}:${version}`,
    `docker pull ${ghcrRef}:${version}`,
    '```',
    '',
    'Both registries serve the same `linux/amd64` + `linux/arm64` index,',
    `\`${indexDigest}\`.`,
    '',
    'The image ships without OpenCode, so a bare `docker run` exits at',
    'startup by design — see [Run it in a container](https://github.com/looptroop-ai/LoopTroop#run-it-in-a-container)',
    'for how to point it at a server and reach the interface.',
    END,
  ].join('\n')
}

/**
 * The notes with this release's container block in them, exactly once.
 *
 * A re-run replaces the existing block rather than appending a second copy, and
 * a hand-edited note above or below it survives untouched. One marker without
 * the other means someone edited the notes inside the block: guessing where it
 * ends could delete their text, so it throws instead.
 */
export function spliceContainerBlock(body: string, input: ContainerBlockInput): string {
  const block = containerBlock(input)
  const start = body.indexOf(START)
  const end = body.indexOf(END)

  let next: string
  if (start !== -1 && end !== -1 && end > start) {
    next = body.slice(0, start) + block + body.slice(end + END.length)
  } else if (start !== -1 || end !== -1) {
    throw new Error('The notes carry one container marker without the other; refusing to guess the block bounds.')
  } else {
    next = `${body.replace(/\s+$/, '')}\n\n${block}`
  }
  return next.endsWith('\n') ? next : `${next}\n`
}
