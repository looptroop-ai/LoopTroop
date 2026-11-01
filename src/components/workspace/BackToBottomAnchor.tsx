import { BACK_TO_BOTTOM_ANCHOR_ATTRIBUTE, registerBackToBottomAnchor } from '@/lib/assistantLauncherAnchor'

/**
 * An invisible box at exactly the spot and size of the log's "Back to bottom"
 * button (`absolute bottom-4 right-6`, p-2 around a 16px icon plus a 1px
 * border). It stays mounted while that button comes and goes, so the assistant
 * launcher lines up with the same place whether or not the button is showing.
 */
export function BackToBottomAnchor() {
  return (
    <span
      ref={registerBackToBottomAnchor}
      aria-hidden="true"
      {...{ [BACK_TO_BOTTOM_ANCHOR_ATTRIBUTE]: '' }}
      className="pointer-events-none absolute bottom-4 right-6 size-[34px]"
    />
  )
}
