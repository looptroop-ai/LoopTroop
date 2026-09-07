/** A timestamp rendered in the viewer's locale, or the raw value when it will not parse. */
export function formatArtifactTimestampLabel(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
