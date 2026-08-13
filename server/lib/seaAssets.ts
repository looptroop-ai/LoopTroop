import { getAssetKeys, getRawAsset } from 'node:sea'
import { isSea } from './isSea'

/**
 * The built interface, read out of the executable instead of off disk.
 *
 * A single-file build has no `dist/client` beside it — it has no directory at
 * all — so the walk that finds the interface in an npm install returns nothing
 * and every page is a 404 while the API answers normally. That failure is
 * invisible to anything except a request for an actual document, which is why
 * the spike asserts a page rather than only a version.
 *
 * Assets are embedded under `client/…` keys mirroring the built tree, so the
 * mapping from a request path to a key is a lookup rather than a guess. Vite
 * hashes asset filenames, so there is nothing to invalidate on upgrade: a new
 * build embeds new keys.
 */
const PREFIX = 'client/'

/** Enough to cover what Vite emits; anything else is served as bytes. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()])
    ?? 'application/octet-stream'
}

/**
 * Read once. `getAssetKeys` is cheap, but the answer cannot change while the
 * process runs, and every request would otherwise pay for it.
 */
let keys: Set<string> | null = null

function assetKeys(): Set<string> {
  if (keys === null) {
    keys = isSea() ? new Set(getAssetKeys()) : new Set<string>()
  }
  return keys
}

/** Whether this build carries an embedded interface at all. */
export function hasEmbeddedClient(): boolean {
  return assetKeys().has(`${PREFIX}index.html`)
}

export interface EmbeddedAsset {
  body: ArrayBuffer
  contentType: string
}

/**
 * An embedded asset by request path, or `null` when there is no such asset.
 *
 * The leading slash is stripped and the path is looked up verbatim: no walking,
 * no normalisation beyond that, so `..` cannot reach a key it should not — the
 * key either exists in the set or it does not.
 */
export function embeddedAsset(requestPath: string): EmbeddedAsset | null {
  if (!isSea()) return null

  const key = `${PREFIX}${requestPath.replace(/^\/+/, '')}`
  if (!assetKeys().has(key)) return null

  return { body: getRawAsset(key), contentType: contentTypeFor(key) }
}

/** The SPA document, for deep links that have no file behind them. */
export function embeddedIndex(): EmbeddedAsset | null {
  return embeddedAsset('/index.html')
}
