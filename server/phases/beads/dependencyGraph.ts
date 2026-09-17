export interface BeadDependencyGraphEntry {
  id: string
  dependencies: { blocked_by: string[]; blocks: string[] }
}

export interface BeadDependencyGraphValidation {
  /** Messages in the order the pre-flight doctor has always reported them. */
  errors: string[]
  /** Structural validity, including dangling/self/duplicate/cycle errors. */
  graphValid: boolean
  /** Whether every declared edge has the matching inverse. */
  edgesConsistent: boolean
}

/**
 * Validate the graph the scheduler actually executes.
 *
 * `blocked_by` remains authoritative for cycle detection and scheduling, while
 * `blocks` is checked as its required inverse. Keeping this algorithm here
 * gives approval, routes, and pre-flight one set of graph diagnostics without
 * changing the doctor's check name or its separate one-sided-edge reporting.
 */
export function inspectBeadDependencyGraph(
  beads: readonly BeadDependencyGraphEntry[],
): BeadDependencyGraphValidation {
  const errors: string[] = []
  const beadIds = new Set(beads.map((bead) => bead.id))
  let graphValid = true

  for (const bead of beads) {
    for (const dependency of bead.dependencies.blocked_by) {
      if (!beadIds.has(dependency)) {
        graphValid = false
        errors.push(`Bead ${bead.id} has dangling blocked_by dependency: ${dependency}`)
      }
    }
    for (const dependency of bead.dependencies.blocks) {
      if (!beadIds.has(dependency)) {
        graphValid = false
        errors.push(`Bead ${bead.id} has dangling blocks dependency: ${dependency}`)
      }
    }
    if (bead.dependencies.blocked_by.includes(bead.id) || bead.dependencies.blocks.includes(bead.id)) {
      graphValid = false
      errors.push(`Bead ${bead.id} has self-dependency`)
    }
  }

  const beadsById = new Map(beads.map((bead) => [bead.id, bead]))
  let edgesConsistent = true
  for (const bead of beads) {
    for (const dependency of bead.dependencies.blocks) {
      const target = beadsById.get(dependency)
      if (!target || target.dependencies.blocked_by.includes(bead.id)) continue
      edgesConsistent = false
      errors.push(`Bead ${bead.id} declares it blocks ${dependency}, but ${dependency} does not list ${bead.id} in blocked_by`)
    }
    for (const dependency of bead.dependencies.blocked_by) {
      const target = beadsById.get(dependency)
      if (!target || target.dependencies.blocks.includes(bead.id)) continue
      edgesConsistent = false
      errors.push(`Bead ${bead.id} is blocked by ${dependency}, but ${dependency} does not list ${bead.id} in blocks`)
    }
  }

  if (beads.length > 0 && beadIds.size !== beads.length) {
    graphValid = false
    const seen = new Set<string>()
    for (const bead of beads) {
      if (seen.has(bead.id)) errors.push(`Duplicate bead ID: ${bead.id}`)
      seen.add(bead.id)
    }
  }

  if (beads.length > 0 && graphValid) {
    const visited = new Set<string>()
    const recStack = new Set<string>()

    let cyclePath: string[] | null = null

    const detectCycle = (beadId: string, path: string[]): boolean => {
      visited.add(beadId)
      recStack.add(beadId)
      path.push(beadId)

      const bead = beadsById.get(beadId)
      if (bead) {
        for (const dependency of bead.dependencies.blocked_by) {
          if (!visited.has(dependency)) {
            if (detectCycle(dependency, path)) return true
          } else if (recStack.has(dependency)) {
            const cycleStart = path.indexOf(dependency)
            cyclePath = [...path.slice(cycleStart >= 0 ? cycleStart : 0), dependency]
            return true
          }
        }
      }

      path.pop()
      recStack.delete(beadId)
      return false
    }

    let hasCycle = false
    for (const bead of beads) {
      if (!visited.has(bead.id) && detectCycle(bead.id, [])) {
        hasCycle = true
        break
      }
    }
    if (hasCycle) {
      graphValid = false
      errors.push(`Circular dependency detected in bead graph: ${(cyclePath as string[] | null)?.join(' -> ') ?? 'unknown'}`)
    }
  }

  return { errors, graphValid, edgesConsistent }
}

/** The approval and route-facing form of the shared graph diagnostics. */
export function validateBeadDependencyGraph(beads: readonly BeadDependencyGraphEntry[]): string[] {
  return [...new Set(inspectBeadDependencyGraph(beads).errors)]
}
