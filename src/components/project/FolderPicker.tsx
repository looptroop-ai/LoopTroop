import { useState, useEffect, useRef, useCallback } from 'react'
import { Folder, ArrowUp, CheckCircle2, XCircle, CircleDot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FullScreenModal } from '@/components/shared/FullScreenModal'
import { cn } from '@/lib/utils'
import { GIT_CHECK_DEBOUNCE_MS } from '@/lib/constants'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface DirItem {
    name: string
    path: string
}

interface LsResponse {
    currentPath: string
    parentPath: string | null
    dirs: DirItem[]
    error?: string
}

interface FolderPickerProps {
    open: boolean
    onClose: () => void
    onSelect: (path: string) => void
    initialPath?: string
}

interface GitCheckResponse {
    isGit: boolean
    status: 'none' | 'checking' | 'valid' | 'invalid'
    message?: string
    performanceWarning?: string | null
    scope?: 'root' | 'subfolder'
    repoRoot?: string
}

type GitStatus = 'none' | 'checking' | 'valid' | 'invalid'

export function FolderPicker({ open, onClose, onSelect, initialPath }: FolderPickerProps) {

    const [data, setData] = useState<LsResponse | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [inputPath, setInputPath] = useState('')
    const [gitStatus, setGitStatus] = useState<GitStatus>('none')
    const [gitMessage, setGitMessage] = useState('')
    const [performanceWarning, setPerformanceWarning] = useState('')
    const gitCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    /**
     * Which navigation the results on screen belong to.
     *
     * Both requests are debounced but neither was cancelled, so listing a large
     * directory and then moving on left the slow answer to arrive last and
     * overwrite the current one — including the git verdict, which is what
     * enables "Select This Folder". The counter is bumped by every navigation
     * and by opening the dialog; a response whose generation is no longer
     * current is dropped rather than rendered.
     */
    const requestGenerationRef = useRef(0)

    useEffect(() => {
        return () => {
            requestGenerationRef.current += 1
            if (gitCheckRef.current) clearTimeout(gitCheckRef.current)
        }
    }, [])

    const checkGit = useCallback((path: string, generation: number) => {
        if (gitCheckRef.current) clearTimeout(gitCheckRef.current)
        if (generation !== requestGenerationRef.current) return
        if (!path) { setGitStatus('none'); setGitMessage(''); setPerformanceWarning(''); return }
        setGitStatus('checking')
        setGitMessage('Checking repository...')
        gitCheckRef.current = setTimeout(async () => {
            if (generation !== requestGenerationRef.current) return
            try {
                const res = await fetch(`/api/projects/check-git?path=${encodeURIComponent(path)}`)
                const d = await res.json() as GitCheckResponse
                if (generation !== requestGenerationRef.current) return
                setGitStatus(d.isGit ? 'valid' : 'invalid')
                setGitMessage(String(d.message ?? ''))
                setPerformanceWarning(String(d.performanceWarning ?? ''))
            } catch {
                if (generation !== requestGenerationRef.current) return
                setGitStatus('invalid')
                setGitMessage('Git check failed.')
                setPerformanceWarning('')
            }
        }, GIT_CHECK_DEBOUNCE_MS)
    }, [])

    const fetchLs = useCallback(async (pathStr: string) => {
        const generation = ++requestGenerationRef.current
        setIsLoading(true)
        setError(null)
        try {
            const res = await fetch(`/api/projects/ls?path=${encodeURIComponent(pathStr)}`)
            const d = await res.json()
            if (generation !== requestGenerationRef.current) return
            if (d.error) {
                setError(d.error)
            } else {
                setData(d)
                setInputPath(d.currentPath)
                checkGit(d.currentPath, generation)
            }
        } catch {
            if (generation !== requestGenerationRef.current) return
            setError('Failed to fetch directory contents.')
        } finally {
            if (generation === requestGenerationRef.current) setIsLoading(false)
        }
    }, [checkGit])

    useEffect(() => {
        if (open) {
            requestGenerationRef.current += 1
            setGitStatus('none')
            setGitMessage('')
            setPerformanceWarning('')
            fetchLs(initialPath || '')
        }
    }, [open, initialPath, fetchLs])

    const gitIcon = gitStatus === 'valid'
        ? <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
        : gitStatus === 'invalid'
            ? <XCircle className="h-5 w-5 text-red-500 shrink-0" />
            : <CircleDot className={cn('h-5 w-5 text-orange-500 shrink-0', gitStatus === 'checking' && 'animate-pulse')} />

    return (
        <FullScreenModal open={open} onClose={onClose} title="Select Directory">
            <div className="max-w-4xl mx-auto flex flex-col h-full gap-4">

                {/* Navigation Bar */}
                <div className="flex gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                                            variant="outline"
                                            size="icon"
                                            aria-label="Go up one level"
                                            disabled={!data?.parentPath || isLoading}
                                            onClick={() => data?.parentPath && fetchLs(data.parentPath)}
                                        >
                                            <ArrowUp className="h-4 w-4" />
                                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-center text-balance">Go up one level</TooltipContent>
                    </Tooltip>

                    <form
                        className="flex-1 flex gap-2"
                        onSubmit={(e) => { e.preventDefault(); fetchLs(inputPath) }}
                    >
                        <input
                            type="text"
                            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                            value={inputPath}
                            onChange={(e) => setInputPath(e.target.value)}
                            placeholder="Enter absolute path"
                        />
                        <Button type="submit" variant="secondary" disabled={isLoading}>Go</Button>
                    </form>
                </div>

                {error && (
                    <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md text-sm font-medium">
                        {error}
                    </div>
                )}

                {/* Directory List */}
                <div className="flex-1 border border-border rounded-md bg-background overflow-y-auto w-full">
                    {isLoading ? (
                        <div className="p-8 text-center text-muted-foreground animate-pulse text-sm">Loading directories...</div>
                    ) : data?.dirs.length === 0 ? (
                        <div className="p-8 text-center text-muted-foreground text-sm">No subdirectories found.</div>
                    ) : (
                        <ul className="divide-y divide-border">
                            {data?.dirs.map((d) => (
                                <li key={d.path}>
                                    <button
                                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted transition text-sm focus-visible:bg-muted outline-none text-left"
                                        onClick={() => fetchLs(d.path)}
                                    >
                                        <Folder className="h-5 w-5 text-blue-500 fill-blue-500/20 shrink-0" />
                                        <span className="font-medium truncate">{d.name}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* Action Bar */}
                <div className="flex justify-between items-center bg-muted/50 p-4 rounded-md border border-border shrink-0">
                    <div className="flex items-center gap-2 min-w-0 mr-4">
                        {gitIcon}
                        <div className="min-w-0">
                            <div className="text-sm truncate font-mono font-medium">{data?.currentPath || inputPath}</div>
                            {gitMessage && (
                                <div className={cn(
                                    'text-xs mt-0.5',
                                    gitStatus === 'valid' ? 'text-green-600 dark:text-green-400'
                                        : gitStatus === 'invalid' ? 'text-red-600 dark:text-red-400'
                                            : 'text-muted-foreground',
                                )}>
                                    {gitMessage}
                                </div>
                            )}
                            {performanceWarning && (
                                <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                                    {performanceWarning}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                        <Button variant="outline" onClick={onClose}>Cancel</Button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                                                    disabled={isLoading || !!error || !data?.currentPath || gitStatus !== 'valid'}
                                                    onClick={() => data?.currentPath && onSelect(data.currentPath)}
                                                >
                                                    <CheckCircle2 className="h-4 w-4 mr-2" />
                                                    Select This Folder
                                                </Button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-center text-balance">{gitStatus === 'invalid' ? 'Selected folder is not a git repository' : gitStatus === 'checking' ? 'Checking git status...' : ''}</TooltipContent>
                        </Tooltip>
                    </div>
                </div>

            </div>
        </FullScreenModal>
    )
}
