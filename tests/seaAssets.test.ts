import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Serving the built interface out of the executable.
 *
 * A single-file build has no `dist/client` beside it — no directory at all — so
 * the walk that finds the interface in an npm install returns nothing and every
 * page 404s while the API answers normally. That failure is invisible to
 * anything except a request for an actual document.
 */
const sea = vi.hoisted(() => ({
  isSea: false,
  assets: new Map<string, string>(),
}))

vi.mock('../server/lib/isSea', () => ({ isSea: () => sea.isSea }))
vi.mock('node:sea', () => ({
  getAssetKeys: () => [...sea.assets.keys()],
  getRawAsset: (key: string) => {
    const value = sea.assets.get(key)
    if (value === undefined) throw new Error(`no asset ${key}`)
    return new TextEncoder().encode(value).buffer
  },
}))

beforeEach(() => {
  vi.resetModules()
  sea.isSea = false
  sea.assets = new Map()
})

async function load() {
  return import('../server/lib/seaAssets')
}

function text(body: ArrayBuffer): string {
  return new TextDecoder().decode(body)
}

describe('the embedded interface', () => {
  it('reports none at all when this is not a single-file build', async () => {
    sea.assets.set('client/index.html', '<!doctype html>')

    const { hasEmbeddedClient, embeddedAsset } = await load()

    expect(hasEmbeddedClient()).toBe(false)
    expect(embeddedAsset('/index.html')).toBeNull()
  })

  it('reports none when the build carries no interface', async () => {
    sea.isSea = true

    expect((await load()).hasEmbeddedClient()).toBe(false)
  })

  it('serves a document and its hashed assets', async () => {
    sea.isSea = true
    sea.assets.set('client/index.html', '<!doctype html><script src="/assets/app-abc.js">')
    sea.assets.set('client/assets/app-abc.js', 'export const x = 1')

    const { hasEmbeddedClient, embeddedAsset } = await load()

    expect(hasEmbeddedClient()).toBe(true)
    expect(text(embeddedAsset('/index.html')!.body)).toContain('<!doctype html>')
    expect(text(embeddedAsset('/assets/app-abc.js')!.body)).toBe('export const x = 1')
  })

  /**
   * A wrong content type is not cosmetic: a browser refuses a module served as
   * `application/octet-stream` and reports a MIME error rather than the real
   * problem.
   */
  it.each([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/assets/app-abc.js', 'text/javascript; charset=utf-8'],
    ['/assets/app-abc.css', 'text/css; charset=utf-8'],
    ['/assets/logo-abc.svg', 'image/svg+xml'],
    ['/assets/font-abc.woff2', 'font/woff2'],
    ['/assets/blob-abc.bin', 'application/octet-stream'],
  ])('types %s as %s', async (path, expected) => {
    sea.isSea = true
    sea.assets.set(`client${path}`, 'x')

    expect((await load()).embeddedAsset(path)!.contentType).toBe(expected)
  })

  it('has nothing for a path it does not carry', async () => {
    sea.isSea = true
    sea.assets.set('client/index.html', 'x')

    expect((await load()).embeddedAsset('/assets/missing-abc.js')).toBeNull()
  })

  /**
   * The key is looked up verbatim rather than resolved, so a traversal cannot
   * name something outside the embedded tree: it either matches a key or it
   * does not.
   */
  it('cannot be walked out of', async () => {
    sea.isSea = true
    sea.assets.set('client/index.html', 'x')
    sea.assets.set('secret', 'do not serve me')

    const { embeddedAsset } = await load()

    expect(embeddedAsset('/../secret')).toBeNull()
    expect(embeddedAsset('/..%2Fsecret')).toBeNull()
  })

  it('finds the document deep links fall back to', async () => {
    sea.isSea = true
    sea.assets.set('client/index.html', '<!doctype html>')

    expect(text((await load()).embeddedIndex()!.body)).toBe('<!doctype html>')
  })
})
