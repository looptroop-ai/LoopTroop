import { describe, expect, it } from 'vitest'
import {
  isMixedViteReactDependencyError,
  shouldRecoverMixedViteReactDependencyError,
} from '../viteDependencyRecovery'

function mixedGenerationError(): TypeError {
  const error = new TypeError("Cannot read properties of null (reading 'useContext')")
  error.stack = [
    "TypeError: Cannot read properties of null (reading 'useContext')",
    '    at exports.useContext (http://localhost:5173/node_modules/.vite/deps/react.js?v=1523fa2f:706:22)',
    '    at useQuery (http://localhost:5173/node_modules/.vite/deps/@tanstack_react-query.js?v=1523fa2f:2721:9)',
    '    at Provider (http://localhost:5173/node_modules/.vite/deps/@tanstack_react-query.js?v=e856e9bf:2551:30)',
  ].join('\n')
  return error
}

function mixedReactRuntimeError(): TypeError {
  const error = new TypeError("Cannot read properties of null (reading 'useState')")
  error.stack = [
    "TypeError: Cannot read properties of null (reading 'useState')",
    '    at exports.useState (https://example.test/node_modules/.vite/deps/react.js?v=4d9a81b0:748:30)',
    '    at DraftView (https://example.test/src/components/workspace/DraftView.tsx:83:58)',
    '    at Object.react_stack_bottom_frame (https://example.test/node_modules/.vite/deps/react-dom_client.js?v=2e31e16e:12866:12)',
  ].join('\n')
  return error
}

describe('Vite dependency recovery', () => {
  it('recognizes the mixed React Query generations from a restored dev page', () => {
    const error = mixedGenerationError()

    expect(isMixedViteReactDependencyError(error)).toBe(true)
    expect(shouldRecoverMixedViteReactDependencyError(error, true)).toBe(true)
  })

  it('recognizes a null React hook dispatcher when React and React DOM generations differ', () => {
    expect(isMixedViteReactDependencyError(mixedReactRuntimeError())).toBe(true)
  })

  it('never enables the automatic recovery outside development', () => {
    expect(shouldRecoverMixedViteReactDependencyError(mixedGenerationError(), false)).toBe(false)
  })

  it('keeps normal hook failures and single-generation stacks on the crash screen', () => {
    const applicationError = new TypeError("Cannot read properties of null (reading 'useContext')")
    applicationError.stack = 'at TicketContext (http://localhost:5173/src/context/TicketContext.tsx:12:3)'

    const singleGenerationError = mixedGenerationError()
    singleGenerationError.stack = singleGenerationError.stack?.replace('e856e9bf', '1523fa2f')

    expect(isMixedViteReactDependencyError(applicationError)).toBe(false)
    expect(isMixedViteReactDependencyError(singleGenerationError)).toBe(false)
    expect(isMixedViteReactDependencyError(new Error('Loading ticket failed'))).toBe(false)
  })
})
