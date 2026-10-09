import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AdvancedSettingsProps {
  isOpen: boolean
  onToggle: () => void
  hasWaitError: boolean
  contentClassName?: string
  children: ReactNode
}

export const AdvancedSettings = ({ isOpen, onToggle, hasWaitError, contentClassName, children }: AdvancedSettingsProps) => (
  <div className="rounded-md border-2 border-border">
    <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium" onClick={onToggle} aria-expanded={isOpen}>
      <span>Advanced</span>
      <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
    </button>
    {!isOpen && hasWaitError && <p role="alert" className="px-3 pb-2 text-xs text-destructive">Fix AI question wait in Advanced.</p>}
    <div hidden={!isOpen} className={cn('space-y-3 border-t border-border px-3 py-3', contentClassName)}>{children}</div>
  </div>
)

interface AdvancedSettingRowProps {
  label: string
  help: ReactNode
  description: ReactNode
  className?: string
  children: ReactNode
}

export const AdvancedSettingRow = ({ label, help, description, className, children }: AdvancedSettingRowProps) => (
  <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5"><h4 className="text-sm font-medium">{label}</h4>{help}</div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
    {children}
  </div>
)
