import type { Context } from 'hono'
import {
  getTicketByRef,
  getPhaseArtifactById,
  getTicketPaths,
  listArtifactManifest,
  listPhaseArtifacts,
  listPhaseAttempts,
  toArtifactManifestEntry,
} from '../../storage/tickets'
import { getRequiredRouteParam, getTicketParam } from './routeUtils'

export async function handleGetTicketSize(c: Context) {
  const ticketId = getRequiredRouteParam(c, 'id')
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)

  const paths = getTicketPaths(ticketId)
  if (!paths || !paths.worktreePath) {
    return c.json({ size: 0, exists: false })
  }

  const { worktreePath, ticketDir, executionLogPath, debugLogPath, aiLogPath } = paths

  const fsPromises = await import('node:fs/promises')
  const path = await import('node:path')

  async function getDirectorySize(dirPath: string): Promise<number> {
    let size = 0
    try {
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
      const results = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name)
          try {
            const stats = await fsPromises.lstat(fullPath)
            if (stats.isDirectory()) {
              return getDirectorySize(fullPath)
            } else if (stats.isFile()) {
              return stats.size
            }
          } catch {
            // Ignore individual file errors (permissions, broken symlinks)
          }
          return 0
        })
      )
      size = results.reduce((acc, current) => acc + current, 0)
    } catch {
      // Ignore directory read errors
    }
    return size
  }

  async function getFileSize(filePath: string): Promise<number> {
    try {
      const stats = await fsPromises.stat(filePath)
      return stats.isFile() ? stats.size : 0
    } catch {
      return 0
    }
  }

  interface SizeNode {
    name: string
    size: number
    isDirectory: boolean
    children?: SizeNode[]
  }

  async function getDirectoryChildren(
    dirPath: string,
    excludeNames: string[] = []
  ): Promise<SizeNode[]> {
    try {
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
      const children = await Promise.all(
        entries.map(async (entry) => {
          if (excludeNames.includes(entry.name)) return null
          const fullPath = path.join(dirPath, entry.name)
          const isDirectory = entry.isDirectory()
          let size = 0
          let nestedChildren: SizeNode[] | undefined
          try {
            const stats = await fsPromises.lstat(fullPath)
            if (stats.isDirectory()) {
              size = await getDirectorySize(fullPath)
              nestedChildren = await getDirectoryChildren(fullPath)
            } else if (stats.isFile()) {
              size = stats.size
            }
          } catch {
            // Ignore error
          }
          return {
            name: entry.name,
            size,
            isDirectory,
            ...(nestedChildren && nestedChildren.length > 0 ? { children: nestedChildren } : {})
          }
        })
      )
      return children
        .filter((c): c is SizeNode => c !== null && c.size > 0)
        .sort((a, b) => b.size - a.size)
    } catch {
      return []
    }
  }

  async function getArtifactsChildren(): Promise<SizeNode[]> {
    if (!ticketDir) return []
    const list: SizeNode[] = []
    try {
      const topEntries = await fsPromises.readdir(ticketDir, { withFileTypes: true })
      for (const entry of topEntries) {
        const fullPath = path.join(ticketDir, entry.name)
        if (entry.name === 'runtime') {
          try {
            const runtimeEntries = await fsPromises.readdir(fullPath, { withFileTypes: true })
            const runtimeChildren: SizeNode[] = []
            for (const rEntry of runtimeEntries) {
              const rFullPath = path.join(fullPath, rEntry.name)
              const excludeLogs = [
                executionLogPath ? path.basename(executionLogPath) : 'execution-log.jsonl',
                debugLogPath ? path.basename(debugLogPath) : 'execution-log.debug.jsonl',
                aiLogPath ? path.basename(aiLogPath) : 'execution-log.ai.jsonl',
              ]
              if (excludeLogs.includes(rEntry.name)) {
                continue
              }
              const isDir = rEntry.isDirectory()
              const size = isDir ? await getDirectorySize(rFullPath) : await getFileSize(rFullPath)
              if (size > 0) {
                const nested = isDir ? await getDirectoryChildren(rFullPath) : undefined
                runtimeChildren.push({
                  name: rEntry.name,
                  size,
                  isDirectory: isDir,
                  ...(nested && nested.length > 0 ? { children: nested } : {})
                })
              }
            }
            if (runtimeChildren.length > 0) {
              list.push({
                name: 'runtime',
                size: runtimeChildren.reduce((acc, c) => acc + c.size, 0),
                isDirectory: true,
                children: runtimeChildren.sort((a, b) => b.size - a.size)
              })
            }
          } catch {
            // ignore
          }
        } else {
          const isDir = entry.isDirectory()
          const size = isDir ? await getDirectorySize(fullPath) : await getFileSize(fullPath)
          if (size > 0) {
            const nested = isDir ? await getDirectoryChildren(fullPath) : undefined
            list.push({
              name: entry.name,
              size,
              isDirectory: isDir,
              ...(nested && nested.length > 0 ? { children: nested } : {})
            })
          }
        }
      }
    } catch {
      // ignore
    }
    return list.sort((a, b) => b.size - a.size)
  }

  const exists = await fsPromises.stat(worktreePath).then(() => true).catch(() => false)
  if (!exists) {
    return c.json({ size: 0, exists: false })
  }

  const [totalSize, ticketDirSize, execLogSize, debugLogSize, aiLogSize] = await Promise.all([
    getDirectorySize(worktreePath),
    ticketDir ? getDirectorySize(ticketDir) : Promise.resolve(0),
    executionLogPath ? getFileSize(executionLogPath) : Promise.resolve(0),
    debugLogPath ? getFileSize(debugLogPath) : Promise.resolve(0),
    aiLogPath ? getFileSize(aiLogPath) : Promise.resolve(0),
  ])

  const logsSize = execLogSize + debugLogSize + aiLogSize
  const artifactsSize = Math.max(0, ticketDirSize - logsSize)
  const sourceSize = Math.max(0, totalSize - ticketDirSize)

  const logsList = [
    { name: 'execution-log.jsonl', size: execLogSize, isDirectory: false },
    { name: 'execution-log.debug.jsonl', size: debugLogSize, isDirectory: false },
    { name: 'execution-log.ai.jsonl', size: aiLogSize, isDirectory: false },
  ].filter((l) => l.size > 0)

  const [artifactsList, sourceList] = await Promise.all([
    getArtifactsChildren(),
    getDirectoryChildren(worktreePath, ['.ticket']),
  ])

  return c.json({
    size: totalSize,
    exists: true,
    breakdown: {
      logs: {
        total: logsSize,
        children: logsList,
      },
      artifacts: {
        total: artifactsSize,
        children: artifactsList,
      },
      source: {
        total: sourceSize,
        children: sourceList,
      },
    },
  })
}

export function handleListPhaseAttempts(c: Context) {
  const ticketId = getTicketParam(c)
  const phase = c.req.param('phase')
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  if (!phase) return c.json({ error: 'Phase is required' }, 400)
  return c.json(listPhaseAttempts(ticketId, phase))
}

export function handleGetArtifacts(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  const phase = c.req.query('phase')
  const rawPhaseAttempt = c.req.query('phaseAttempt')
  const phaseAttempt = rawPhaseAttempt != null ? Number(rawPhaseAttempt) : undefined
  return c.json(listPhaseArtifacts(ticketId, {
    ...(phase ? { phase } : {}),
    ...(typeof phaseAttempt === 'number' && Number.isFinite(phaseAttempt) && phaseAttempt > 0
      ? { phaseAttempt }
      : {}),
  }))
}

function getArtifactFilters(c: Context): { phase?: string; phaseAttempt?: number } {
  const phase = c.req.query('phase')
  const rawPhaseAttempt = c.req.query('phaseAttempt')
  const phaseAttempt = rawPhaseAttempt != null ? Number(rawPhaseAttempt) : undefined
  return {
    ...(phase ? { phase } : {}),
    ...(typeof phaseAttempt === 'number' && Number.isFinite(phaseAttempt) && phaseAttempt > 0 ? { phaseAttempt } : {}),
  }
}

export function handleGetArtifactManifest(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  return c.json({ artifacts: listArtifactManifest(ticketId, getArtifactFilters(c)) })
}

function parseArtifactId(value: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function handleGetArtifactContent(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  const artifactId = parseArtifactId(c.req.param('artifactId') ?? '')
  if (artifactId === null) return c.json({ error: 'Artifact id must be a positive integer' }, 400)
  const artifact = getPhaseArtifactById(ticketId, artifactId)
  if (!artifact) return c.json({ error: 'Artifact not found' }, 404)
  const manifest = toArtifactManifestEntry(ticketId, artifact)
  const etag = `"${manifest.contentSha256}"`
  c.header('ETag', etag)
  c.header('Cache-Control', 'private, max-age=0, must-revalidate')
  if (c.req.header('if-none-match') === etag) return c.body(null, 304)
  return c.json({ artifact: { ...manifest, content: artifact.content } })
}

const MAX_BATCH_ARTIFACTS = 20
const MAX_BATCH_CONTENT_BYTES = 2 * 1024 * 1024

export async function handlePostArtifactContentBatch(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'Expected a JSON body containing artifactIds' }, 400)
  }
  const rawIds = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).artifactIds
    : null
  if (!Array.isArray(rawIds) || rawIds.length > MAX_BATCH_ARTIFACTS) {
    return c.json({ error: `artifactIds must contain at most ${MAX_BATCH_ARTIFACTS} ids` }, 400)
  }
  const artifactIds = [...new Set(rawIds.map((id) => typeof id === 'number' ? id : Number.NaN))]
  if (artifactIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return c.json({ error: 'artifactIds must contain positive integer ids' }, 400)
  }

  let usedBytes = 0
  const artifacts: Array<ReturnType<typeof toArtifactManifestEntry> & { content: string }> = []
  const omittedIds: number[] = []
  for (const artifactId of artifactIds) {
    const artifact = getPhaseArtifactById(ticketId, artifactId)
    if (!artifact) {
      omittedIds.push(artifactId)
      continue
    }
    const contentBytes = Buffer.byteLength(artifact.content, 'utf8')
    if (usedBytes + contentBytes > MAX_BATCH_CONTENT_BYTES) {
      omittedIds.push(artifactId)
      continue
    }
    usedBytes += contentBytes
    artifacts.push({ ...toArtifactManifestEntry(ticketId, artifact), content: artifact.content })
  }
  return c.json({ artifacts, omittedIds })
}
