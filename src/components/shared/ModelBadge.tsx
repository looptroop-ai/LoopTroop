import type { LucideProps } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getModelDisplayName, getModelIcon } from './modelBadgeUtils'

interface ModelBadgeProps {
    modelId: string
    variant?: string | null
    effort?: string | null
    active?: boolean
    onClick?: () => void
    className?: string
    showIcon?: boolean
    children?: React.ReactNode
}

interface ModelIconProps extends Omit<LucideProps, 'ref'> {
    modelId: string
}

export function ModelIcon({ modelId, className, ...props }: ModelIconProps) {
    const Icon = getModelIcon(modelId)
    return (
        <Icon
            aria-hidden="true"
            className={cn('h-3.5 w-3.5 shrink-0', className)}
            strokeWidth={2}
            {...props}
        />
    )
}

export function ModelBadge({ modelId, variant, effort, active, onClick, className, showIcon = true, children }: ModelBadgeProps) {
    const name = getModelDisplayName(modelId)
    const variantLabel = variant?.trim() || 'Default / not reported'
    const effortLabel = effort?.trim() || 'None (provider default)'
    const title = effort !== undefined
        ? `${modelId} · Effort: ${effortLabel}`
        : variant === undefined
            ? modelId
            : `${modelId} · Variant: ${variantLabel}`

    const Component = onClick ? 'button' : 'div'

    return (
        <Component
            onClick={onClick}
            className={cn(
                'px-2.5 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-semibold shrink-0 max-w-fit truncate border transition-colors shadow-sm inline-flex items-center gap-1.5',
                active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80 border-border/50',
                className
            )}
            title={title}
        >
            {showIcon ? <ModelIcon modelId={modelId} /> : null}
            {children || <span className="truncate">{name}</span>}
        </Component>
    )
}
