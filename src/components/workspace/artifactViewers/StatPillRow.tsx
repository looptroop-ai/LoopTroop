import type React from 'react'

/**
 * The pill row used for artifact counts.
 *
 * §13.1 asked for the count rows in the two diff views to be replaced with
 * `RawDisplayStats`. They cannot be: `RawDisplayStats` derives lines, characters
 * and tokens from a string, while these rows show diff counts. The two share
 * only their markup, so that is what is shared here — the class strings are
 * unchanged, so nothing renders differently.
 */

export function StatPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">{children}</span>
  )
}

export function StatPillRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-wider">{children}</div>
}
