export const EFFORT_META: Record<string, { label: string; shortLabel: string; icon: string; description: string; intensity: number }> = {
  none:    { label: 'None',    shortLabel: 'None', icon: '○',  description: 'No reasoning; fastest and cheapest',                  intensity: 0 },
  minimal: { label: 'Minimal', shortLabel: 'Min',  icon: '◔',  description: 'Minimal reasoning; very fast, low cost',              intensity: 1 },
  low:     { label: 'Low',     shortLabel: 'Low',  icon: '◑',  description: 'Light reasoning; fast with basic analysis',            intensity: 2 },
  medium:  { label: 'Medium',  shortLabel: 'Med',  icon: '◕',  description: 'Balanced reasoning; good quality and speed trade-off', intensity: 3 },
  high:    { label: 'High',    shortLabel: 'High', icon: '●',  description: 'Deep reasoning; thorough analysis, slower',            intensity: 4 },
  xhigh:   { label: 'XHigh',   shortLabel: 'XH',   icon: '⬤',  description: 'Extra high reasoning; maximum effort, most costly',    intensity: 5 },
  max:     { label: 'Max',     shortLabel: 'Max',  icon: '★',  description: 'Maximum thinking budget; deepest analysis possible',   intensity: 5 },
}

export function intensityColorClass(intensity: number): string {
  const colors: Record<number, string> = {
    0: 'text-slate-600 dark:text-slate-400',
    1: 'text-sky-600 dark:text-sky-400',
    2: 'text-blue-600 dark:text-blue-400',
    3: 'text-violet-600 dark:text-violet-400',
    4: 'text-amber-600 dark:text-amber-400',
    5: 'text-orange-600 dark:text-orange-400',
  }
  return colors[intensity] ?? colors[3]!
}
