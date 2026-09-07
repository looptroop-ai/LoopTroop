/**
 * The tooltip styling the two log panels share.
 *
 * Ten call sites across `FullLogView` and `PhaseLogPanel` carried these exact
 * class strings inline — the count legends, the colour legend and the log
 * count chips. §13.5 asks for one shared variant rather than a change to
 * `TooltipContent`'s default: roughly seventy-eight other call sites pass
 * `max-w-xs text-center text-balance`, but that combination is not universal,
 * and moving the default would change wrapping at sites that never opted in.
 */

/** A single-line legend tooltip, capped narrow and centred. */
export const LOG_LEGEND_TOOLTIP_CLASS =
  'text-xs bg-popover text-popover-foreground border border-border shadow-md font-medium max-w-[200px] text-center'

/** The stacked-rows variant, used where the tooltip lists several counts. */
export const LOG_LEGEND_TOOLTIP_STACK_CLASS =
  'flex flex-col gap-1.5 p-2 bg-popover text-popover-foreground border border-border font-medium shadow-md'
