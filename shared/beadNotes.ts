/**
 * One entry in a bead's failure, retry or finalisation note list.
 *
 * Written by the execution phase, read back by the coding view, and declared
 * independently on each side until now.
 */
export interface BeadNoteEntry {
  timestamp: string
  iteration: number
  content: string
  errorCode?: string
}
