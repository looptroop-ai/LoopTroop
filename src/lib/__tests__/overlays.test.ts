import { afterEach, expect, it } from 'vitest'
import { isEscapeClaimedByNestedOverlay } from '../overlays'

afterEach(() => document.body.replaceChildren())

function escapeFrom(target: HTMLElement) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  target.dispatchEvent(event)
  return event
}

it('ignores a hidden assistant dialog when deciding who owns Escape', () => {
  const assistant = document.createElement('section')
  assistant.setAttribute('role', 'dialog')
  assistant.setAttribute('hidden', '')
  const ticket = document.createElement('button')
  document.body.append(assistant, ticket)

  expect(isEscapeClaimedByNestedOverlay(escapeFrom(ticket), null)).toBe(false)
})

it('does not let an open non-modal assistant block Escape outside its panel', () => {
  const assistant = document.createElement('section')
  assistant.setAttribute('role', 'dialog')
  assistant.setAttribute('aria-modal', 'false')
  const ticket = document.createElement('button')
  document.body.append(assistant, ticket)

  expect(isEscapeClaimedByNestedOverlay(escapeFrom(ticket), null)).toBe(false)
})

it('keeps Escape claimed by a modal dialog and by the non-modal panel itself', () => {
  const modal = document.createElement('section')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  const outside = document.createElement('button')
  document.body.append(modal, outside)
  expect(isEscapeClaimedByNestedOverlay(escapeFrom(outside), null)).toBe(true)

  document.body.replaceChildren()
  const assistant = document.createElement('section')
  assistant.setAttribute('role', 'dialog')
  assistant.setAttribute('aria-modal', 'false')
  const closeButton = document.createElement('button')
  assistant.append(closeButton)
  document.body.append(assistant)
  expect(isEscapeClaimedByNestedOverlay(escapeFrom(closeButton), null)).toBe(true)
})
