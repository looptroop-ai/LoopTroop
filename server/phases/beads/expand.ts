import path from 'node:path'
import type { Bead, BeadDependencies, BeadSubset } from './types'

export interface BeadExpansionCandidate {
  id: string
  issueType: string
  labels: string[]
  dependencies: Pick<BeadDependencies, 'blocked_by'> & Partial<Pick<BeadDependencies, 'blocks'>>
  targetFiles: string[]
}

/** Extract epicId and storyId from PRD references for label generation. */
function derivePrdIds(prdRefs: string[]): { epicId: string; storyId: string } {
  let epicId = ''
  let storyId = ''
  for (const ref of prdRefs) {
    const normalized = ref.toUpperCase().trim()
    const storyMatch = normalized.match(/\bUS-\d+(?:-\d+)?\b/)
    if (!storyId && storyMatch?.[0]) {
      storyId = storyMatch[0]
      const epicFromStory = storyId.match(/^US-(\d+)-/i)
      if (!epicId && epicFromStory?.[1]) {
        epicId = `EPIC-${epicFromStory[1]}`
      }
    }

    const epicMatch = normalized.match(/\bEPIC-\d+\b/)
    if (!epicId && epicMatch?.[0]) {
      epicId = epicMatch[0]
    }
  }
  return { epicId, storyId }
}

function deriveLabels(epicId: string, storyId: string, externalRef: string): string[] {
  const labels: string[] = []
  if (externalRef) labels.push(`ticket:${externalRef}`)
  if (epicId) labels.push(`epic:${epicId}`)
  if (storyId) labels.push(`story:${storyId}`)
  return labels
}

export function expandBeads(subsetBeads: BeadSubset[], externalRef: string = ''): Bead[] {
  const now = new Date().toISOString()

  return subsetBeads.map((subset, index) => {
    const { epicId, storyId } = derivePrdIds(subset.prdRefs)
    const labels = deriveLabels(epicId, storyId, externalRef)
    return {
      ...subset,
      priority: index + 1,
      status: 'pending' as const,
      issueType: 'task',
      externalRef,
      labels,
      dependencies: { blocked_by: [], blocks: [] },
      targetFiles: [],
      failedIterationNotes: [],
      userRetryNotes: [],
      finalizationFailureNotes: [],
      iteration: 1,
      createdAt: '',
      updatedAt: now,
      completedAt: '',
      startedAt: '',
      beadStartCommit: null,
    }
  })
}

function compareExactStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

interface PreservedNarrativeDrift {
  cosmeticPaths: string[]
  substantivePaths: string[]
}

interface PreservedFieldDrift extends PreservedNarrativeDrift {
  commandPaths: string[]
}

function normalizeNarrativeText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/u, '')
}

function collectNarrativeStringDrift(fieldPath: string, left: string, right: string): PreservedNarrativeDrift {
  if (left === right) return { cosmeticPaths: [], substantivePaths: [] }
  return normalizeNarrativeText(left) === normalizeNarrativeText(right)
    ? { cosmeticPaths: [fieldPath], substantivePaths: [] }
    : { cosmeticPaths: [], substantivePaths: [fieldPath] }
}

function collectNarrativeArrayDrift(fieldPath: string, left: string[], right: string[]): PreservedNarrativeDrift {
  if (compareExactStringArrays(left, right)) {
    return { cosmeticPaths: [], substantivePaths: [] }
  }
  if (left.length !== right.length) {
    return { cosmeticPaths: [], substantivePaths: [fieldPath] }
  }

  const cosmeticPaths: string[] = []
  const substantivePaths: string[] = []
  for (let index = 0; index < left.length; index += 1) {
    const itemDrift = collectNarrativeStringDrift(`${fieldPath}[${index}]`, left[index] ?? '', right[index] ?? '')
    cosmeticPaths.push(...itemDrift.cosmeticPaths)
    substantivePaths.push(...itemDrift.substantivePaths)
  }
  return { cosmeticPaths, substantivePaths }
}

function collectPreservedCommandArrayDrift(fieldPath: string, left: string[], right: string[]): string[] {
  if (compareExactStringArrays(left, right)) {
    return []
  }
  if (left.length !== right.length) {
    return [fieldPath]
  }

  const commandPaths: string[] = []
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] ?? '') !== (right[index] ?? '')) {
      commandPaths.push(`${fieldPath}[${index}]`)
    }
  }
  return commandPaths
}

function collectPreservedFieldDrift(subset: BeadSubset, bead: Bead): PreservedFieldDrift | null {
  if (subset.title !== bead.title) {
    return null
  }
  if (!compareExactStringArrays(subset.prdRefs, bead.prdRefs)) {
    return null
  }

  const cosmeticPaths: string[] = []
  const substantivePaths: string[] = []

  const descriptionDrift = collectNarrativeStringDrift('description', subset.description, bead.description)
  cosmeticPaths.push(...descriptionDrift.cosmeticPaths)
  substantivePaths.push(...descriptionDrift.substantivePaths)

  const patternDrift = collectNarrativeArrayDrift(
    'contextGuidance.patterns',
    subset.contextGuidance.patterns,
    bead.contextGuidance.patterns,
  )
  cosmeticPaths.push(...patternDrift.cosmeticPaths)
  substantivePaths.push(...patternDrift.substantivePaths)

  const antiPatternDrift = collectNarrativeArrayDrift(
    'contextGuidance.anti_patterns',
    subset.contextGuidance.anti_patterns,
    bead.contextGuidance.anti_patterns,
  )
  cosmeticPaths.push(...antiPatternDrift.cosmeticPaths)
  substantivePaths.push(...antiPatternDrift.substantivePaths)

  const acceptanceCriteriaDrift = collectNarrativeArrayDrift(
    'acceptanceCriteria',
    subset.acceptanceCriteria,
    bead.acceptanceCriteria,
  )
  cosmeticPaths.push(...acceptanceCriteriaDrift.cosmeticPaths)
  substantivePaths.push(...acceptanceCriteriaDrift.substantivePaths)

  const testsDrift = collectNarrativeArrayDrift('tests', subset.tests, bead.tests)
  cosmeticPaths.push(...testsDrift.cosmeticPaths)
  substantivePaths.push(...testsDrift.substantivePaths)

  const commandPaths = collectPreservedCommandArrayDrift('testCommands', subset.testCommands, bead.testCommands)
  if ((subset.testCommandReason ?? '') !== (bead.testCommandReason ?? '')) {
    commandPaths.push('testCommandReason')
  }

  return { cosmeticPaths, substantivePaths, commandPaths }
}

function isProjectRelativePath(filePath: string): boolean {
  if (!filePath.trim()) return false
  if (path.isAbsolute(filePath)) return false
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return false
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'))
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return false
  }
  return true
}

export function validateBeadExpansion(subsetBeads: BeadSubset[], expandedBeads: Bead[]): string[] {
  if (expandedBeads.length !== subsetBeads.length) {
    throw new Error(`Expanded bead count ${expandedBeads.length} does not match refined blueprint count ${subsetBeads.length}`)
  }

  const idToIndex = new Map(expandedBeads.map((bead, index) => [bead.id, index] as const))
  const repairWarnings: string[] = []

  for (const [index, bead] of expandedBeads.entries()) {
    const subset = subsetBeads[index]
    if (!subset) {
      throw new Error(`Expanded bead at index ${index} has no matching refined blueprint bead`)
    }

    const preservedFieldDrift = collectPreservedFieldDrift(subset, bead)
    if (preservedFieldDrift == null) {
      throw new Error(`Expanded bead at index ${index} changed preserved Part 1 fields or order`)
    }
    if (preservedFieldDrift.cosmeticPaths.length > 0) {
      repairWarnings.push(
        `Restored preserved Part 1 narrative fields from the refined blueprint for expanded bead at index ${index} (${subset.id}) after punctuation/whitespace-only drift in: ${preservedFieldDrift.cosmeticPaths.join(', ')}.`,
      )
    }
    if (preservedFieldDrift.substantivePaths.length > 0) {
      repairWarnings.push(
        `Restored preserved Part 1 narrative fields from the refined blueprint for expanded bead at index ${index} (${subset.id}) after substantive drift in: ${preservedFieldDrift.substantivePaths.join(', ')}.`,
      )
    }
    if (preservedFieldDrift.commandPaths.length > 0) {
      repairWarnings.push(
        `Restored preserved Part 1 testCommands from the refined blueprint for expanded bead at index ${index} (${subset.id}) after drift in: ${preservedFieldDrift.commandPaths.join(', ')}.`,
      )
    }

    if (!bead.issueType.trim()) {
      throw new Error(`Expanded bead ${bead.id} is missing issueType`)
    }

    if (!Array.isArray(bead.labels) || bead.labels.length === 0 || bead.labels.some((label) => !label.trim())) {
      throw new Error(`Expanded bead ${bead.id} must include at least one non-empty label`)
    }

    if (!Array.isArray(bead.targetFiles) || bead.targetFiles.length === 0) {
      throw new Error(`Expanded bead ${bead.id} must include at least one target file`)
    }

    for (const targetFile of bead.targetFiles) {
      if (!isProjectRelativePath(targetFile)) {
        throw new Error(`Expanded bead ${bead.id} has invalid target file path "${targetFile}"`)
      }
    }

    for (const dependencyId of bead.dependencies.blocked_by) {
      const dependencyIndex = idToIndex.get(dependencyId)
      if (dependencyIndex == null) {
        throw new Error(`Expanded bead ${bead.id} depends on unknown bead ${dependencyId}`)
      }
      if (dependencyIndex >= index) {
        throw new Error(`Expanded bead ${bead.id} is blocked by later bead ${dependencyId}`)
      }
    }
  }

  return repairWarnings
}

export function hydrateExpandedBeads(
  subsetBeads: BeadSubset[],
  expandedBeads: BeadExpansionCandidate[],
  externalRef: string = '',
): Bead[] {
  const now = new Date().toISOString()
  const blocksById = new Map<string, string[]>()

  for (const bead of expandedBeads) {
    blocksById.set(bead.id, [])
  }

  for (const bead of expandedBeads) {
    for (const dependencyId of bead.dependencies.blocked_by) {
      blocksById.set(dependencyId, [...(blocksById.get(dependencyId) ?? []), bead.id])
    }
  }

  return subsetBeads.map((subset, index) => {
    const expanded = expandedBeads[index]
    if (!expanded) {
      throw new Error(`Missing expanded bead fields for refined blueprint bead ${subset.id}`)
    }

    return {
      ...subset,
      id: expanded.id,
      priority: index + 1,
      status: 'pending' as const,
      issueType: expanded.issueType,
      externalRef,
      labels: expanded.labels,
      dependencies: {
        blocked_by: [...expanded.dependencies.blocked_by],
        blocks: [...(blocksById.get(expanded.id) ?? [])],
      },
      targetFiles: [...expanded.targetFiles],
      failedIterationNotes: [],
      userRetryNotes: [],
      finalizationFailureNotes: [],
      iteration: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: '',
      startedAt: '',
      beadStartCommit: null,
    }
  })
}
