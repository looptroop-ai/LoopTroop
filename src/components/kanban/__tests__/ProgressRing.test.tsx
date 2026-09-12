import { expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ProgressRing } from '../ProgressRing'

it('keeps each ring gradient distinct and stable across progress updates', () => {
  const rings = (percent: number) => <>
    <ProgressRing percent={percent} />
    <ProgressRing percent={percent} />
  </>
  const { container, rerender } = render(rings(10))
  const ids = () => Array.from(container.querySelectorAll('linearGradient'), element => element.id)
  const initialIds = ids()
  expect(new Set(initialIds).size).toBe(2)
  rerender(rings(50))
  expect(ids()).toEqual(initialIds)
  expect(Array.from(container.querySelectorAll('circle[stroke^="url"]'), element => element.getAttribute('stroke')))
    .toEqual(initialIds.map(id => `url(#${id})`))
})
