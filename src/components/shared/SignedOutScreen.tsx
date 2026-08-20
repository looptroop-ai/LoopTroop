import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

const SIGN_IN_COMMAND = 'looptroop open'

/**
 * What the app shows once the daemon has refused this browser's session.
 *
 * The remedy is a command, never a link: the sign-in URL carries a single-use
 * nonce that buys a session, and a page that printed one would put a live
 * credential on screen — and in any screenshot of it. `looptroop open` mints a
 * fresh nonce in the terminal, where the user already is.
 *
 * The second command is here because the first one is not always enough. It
 * launches a browser and cannot make one appear: over SSH, in WSL, or on a
 * machine with no browser registered for http, nothing opens and this screen
 * would otherwise name the command that had just failed, forever.
 */
export function SignedOutScreen() {
  const [isCopied, copy] = useCopyToClipboard()
  // A session cookie is host-only, so one bought at 127.0.0.1 is never sent to
  // localhost even on the same port. Signing in again cannot fix a page that is
  // simply at the other name, and nothing else on screen would say so.
  const wrongHost = typeof window !== 'undefined' && window.location.hostname === 'localhost'

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

        <p className="mt-2 text-sm text-muted-foreground">
          If no browser opens, run <code className="font-mono">looptroop open --print-url</code>{' '}
          and paste the link it prints.
        </p>

        {wrongHost && (
          <p className="mt-4 text-sm text-muted-foreground">
            This page is on <code className="font-mono">localhost</code>. LoopTroop signs browsers
            in at <code className="font-mono">127.0.0.1</code>, and a session at one name is never
            sent to the other — open{' '}
            <code className="font-mono">{`127.0.0.1:${window.location.port}`}</code> instead.
          </p>
        )}

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
