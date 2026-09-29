import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

// ResizeObserver is not available in jsdom
class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
})

// scrollIntoView is not available in jsdom
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  writable: true,
  value: vi.fn(),
})

// scrollTo is not available in jsdom
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  writable: true,
  value: vi.fn(),
})

let store: Record<string, string> = {}
const storage = {
  getItem: (key: string) => (key in store ? store[key]! : null),
  setItem: (key: string, value: string) => {
    store[key] = value
  },
  removeItem: (key: string) => {
    delete store[key]
  },
  clear: () => {
    store = {}
  },
  key: (index: number) => Object.keys(store)[index] ?? null,
  get length() {
    return Object.keys(store).length
  },
}

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: storage,
})
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
})

afterEach(() => {
  cleanup()
  storage.clear()
})
