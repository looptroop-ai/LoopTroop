import * as HoverCardPrimitive from '@radix-ui/react-hover-card'
import { cn } from '@/lib/utils'

const isTestRuntime = import.meta.env.MODE === 'test'

function HoverCard({
  openDelay,
  closeDelay,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      openDelay={isTestRuntime ? 0 : openDelay}
      closeDelay={isTestRuntime ? 0 : closeDelay}
      {...props}
    />
  )
}

const HoverCardTrigger = HoverCardPrimitive.Trigger

function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-[100] w-64 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
