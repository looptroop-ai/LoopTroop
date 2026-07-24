import { cn } from '@/lib/utils'
import { Coins, Flame, Brain, Maximize2, Gift, Settings } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

interface OpenRouterRoutingPickerProps {
  value: string | undefined
  onChange: (suffix: string) => void
  disabled?: boolean
}

const ROUTING_OPTIONS = [
  { value: '', label: 'Default', icon: Settings, colorClass: 'text-slate-500 dark:text-slate-400', description: 'Default provider routing', selectedClass: 'bg-slate-100 text-slate-700 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700' },
  { value: ':floor', label: 'Floor', icon: Coins, colorClass: 'text-emerald-600 dark:text-emerald-400', description: 'Cost focus: route to the cheapest provider', selectedClass: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-800' },
  { value: ':nitro', label: 'Nitro', icon: Flame, colorClass: 'text-orange-600 dark:text-orange-400', description: 'Speed focus: route to the fastest provider', selectedClass: 'bg-orange-100 text-orange-800 ring-1 ring-orange-400 dark:bg-orange-950/60 dark:text-orange-200 dark:ring-orange-800' },
  { value: ':thinking', label: 'Thinking', icon: Brain, colorClass: 'text-purple-600 dark:text-purple-400', description: 'Reasoning focus: enable chain-of-thought outputs', selectedClass: 'bg-purple-100 text-purple-800 ring-1 ring-purple-300 dark:bg-purple-950/60 dark:text-purple-200 dark:ring-purple-800' },
  { value: ':extended', label: 'Extended', icon: Maximize2, colorClass: 'text-blue-600 dark:text-blue-400', description: 'Context focus: prefer longer-context providers', selectedClass: 'bg-blue-100 text-blue-800 ring-1 ring-blue-300 dark:bg-blue-950/60 dark:text-blue-200 dark:ring-blue-800' },
  { value: ':free', label: 'Free', icon: Gift, colorClass: 'text-sky-600 dark:text-sky-400', description: 'Free tier focus: force routing to free providers only', selectedClass: 'bg-sky-100 text-sky-800 ring-1 ring-sky-300 dark:bg-sky-950/60 dark:text-sky-200 dark:ring-sky-800' },
] as const

export function OpenRouterRoutingPicker({ value = '', onChange, disabled }: OpenRouterRoutingPickerProps) {
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">Routing:</span>
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/30 p-0.5">
        {ROUTING_OPTIONS.map((option) => {
          const Icon = option.icon
          const selected = value === option.value
          return (
            <Tooltip key={option.value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(option.value)}
                  className={cn(
                    'relative cursor-pointer select-none rounded-md px-2 py-0.5 text-xs font-medium transition-all duration-200',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                    selected ? option.selectedClass : 'bg-muted/40 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground',
                    selected && 'scale-[1.02] shadow-sm',
                  )}
                >
                  <span className="flex items-center gap-1 text-[10px]">
                    <Icon className={cn('h-3 w-3', option.colorClass)} />
                    <span>{option.label}</span>
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center text-balance">{option.description}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
