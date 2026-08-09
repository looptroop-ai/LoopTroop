import { useSyncExternalStore, type ReactNode } from 'react'
import { isSignedOut, subscribeToSessionState } from '@/lib/sessionState'
import { SignedOutScreen } from './SignedOutScreen'

/**
 * Swaps the app for an explanation the moment the daemon stops accepting this
 * browser's session.
 *
 * Mounted above everything that queries: an app whose every request is refused
 * has nothing to show, and leaving it mounted only means a screen full of
 * spinners and empty lists competing with the one message that matters.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const signedOut = useSyncExternalStore(subscribeToSessionState, isSignedOut, isSignedOut)

  return signedOut ? <SignedOutScreen /> : <>{children}</>
}
