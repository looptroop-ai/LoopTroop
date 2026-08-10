import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

const SIGN_IN_COMMAND = 'looptroop open'

/**
 * What the app shows once the daemon has refused this browser's session.
 *
 * The remedy is a command, never a link: the sign-in URL carries a single-use
 * nonce that buys a session, and a page that printed one would put a live
 * credential on screen — and in any screenshot of it. `looptroop open` mints a
 * fresh nonce in the terminal, where the user already is.
 */
export function SignedOutScreen() {
  const [isCopied, copy] = useCopyToClipboard()

  return (
    <div className="flex min-h-screen items-center justify-center p-8 text-center">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-bold">Signed out</h1>
        <p className="mt-2 text-muted-foreground">
          This browser is no longer signed in to LoopTroop. Sessions last 12 hours, and a
          restarted daemon ends them early.
        </p>

        <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-left">
          <p className="text-sm text-muted-foreground">Run this in your terminal to sign in again:</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <code className="font-mono text-sm">{SIGN_IN_COMMAND}</code>
            <button
              type="button"
              onClick={() => { void copy(SIGN_IN_COMMAND) }}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              {isCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          It opens a signed-in tab. This one works again after a reload.
        </p>

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Reload
        </button>
      </div>
    </div>
  )
}
