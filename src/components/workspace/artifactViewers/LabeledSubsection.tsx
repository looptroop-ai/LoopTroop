import type React from 'react'

/**
 * The small uppercase caption above a block of artifact detail.
 *
 * Kept as its own class string rather than reusing `.section-label`: the two
 * differ in letter-spacing, and §13.5 is explicit that the subsection class
 * must not be folded into it.
 */
const SUBSECTION_LABEL_CLASS = 'mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'

/** The caption alone, for the sites that supply their own wrapper. */
export function SubsectionLabel({ children }: { children: React.ReactNode }) {
  return <div className={SUBSECTION_LABEL_CLASS}>{children}</div>
}

/** A captioned block: the caption, then its content. */
export function LabeledSubsection({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <SubsectionLabel>{label}</SubsectionLabel>
      {children}
    </div>
  )
}
