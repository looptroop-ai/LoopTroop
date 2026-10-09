import type { KeyboardEvent } from 'react'

const ARROW_DIRECTION: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }

/** Select and focus the adjacent enabled radio, wrapping at either end. */
export const handleRadioGroupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
  const direction = ARROW_DIRECTION[event.key]
  if (!direction) return
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'))
  const index = radios.indexOf(event.target as HTMLButtonElement)
  const next = radios[(index + direction + radios.length) % radios.length]
  event.preventDefault()
  next?.focus()
  next?.click()
}
