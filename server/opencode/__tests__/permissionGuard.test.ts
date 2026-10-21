import { describe, expect, it } from 'vitest'
import {
  getPermissionGuardRejection,
  type PermissionGuardContext,
} from '../permissionGuard'

const context: PermissionGuardContext = {
  projectRoot: '/repo',
  worktreePath: '/repo/.looptroop/worktrees/T-1',
  ticketDir: '/repo/.looptroop/worktrees/T-1/.ticket',
}

const shell = (command: string, options: { directory?: string; patterns?: string[]; context?: PermissionGuardContext } = {}) =>
  getPermissionGuardRejection({ permission: 'bash', patterns: options.patterns ?? [command], context: options.context ?? context, directory: options.directory })

describe('getPermissionGuardRejection', () => {
  it.each([
    'gh auth status',
    'rtk gh pr view 12',
    'rtk git status --short',
    'rtk proxy git status --short',
    'gh issue list --repo owner/repo',
    'gh pr view 12 --json title,body',
    'gh pr checks 12',
    'gh pr diff 12',
    'gh repo view owner/repo',
    'gh search prs "is:open"',
    'gh release list',
    'gh release download v1.2.3',
    'gh codespace ports -c my-codespace --json sourcePort,visibility',
    'gh api /repos/owner/repo/pulls --paginate',
    'gh api -X GET /repos/owner/repo/issues -f per_page=10',
    "gh api graphql -f query='query { viewer { login } }'",
    "gh api graphql -f query='{ viewer { login } }'",
    "gh api graphql -f query='query { viewer { bio(text: \"mutation\") } }'",
    "gh api graphql -f query='query Read { viewer { login } }, query AlsoRead { viewer { login } }'",
    'git status --short',
    'git add src/new.ts && git commit -m update',
    'git -C /tmp/test-repo init && git -C /tmp/test-repo commit -m test && git -C /tmp/test-repo reset --hard',
    'cd /tmp/scratch && git reset --hard',
    'git init /tmp/scratch-repo',
    'git clone https://example.test/repo.git /tmp/scratch-repo',
    'git clone https://example.test/scratch-repo.git',
    'git --git-dir=/tmp/scratch-repo/.git --work-tree=/tmp/scratch-repo reset --hard',
    'git init --separate-git-dir=/tmp/scratch-git /tmp/scratch-worktree',
    'git clone --separate-git-dir=/tmp/scratch-git https://example.test/repo.git /tmp/scratch-worktree',
    'GIT_DIR=/tmp/scratch-repo/.git GIT_WORK_TREE=/tmp/scratch-repo git reset --hard',
    'env GIT_DIR=/tmp/scratch-repo/.git GIT_WORK_TREE=/tmp/scratch-repo git reset --hard',
    'git clean -ndx',
    'rm src/old.ts',
    'rm -rf dist/*',
    'tee dist/output.log',
    'cp src/config.json dist/config.json',
    'mv src/old.ts dist/old.ts',
    'truncate -s 0 dist/cache.db',
    'rm -rf dist && Remove-Item -Recurse node_modules',
    'rm -rf .ticket/runtime/execution-setup',
    'rm -rf .ticket/runtime/execution-setup/tool-cache',
    'npm test && git status',
  ])('allows safe command: %s', (command) => {
    expect(shell(command)).toBeNull()
  })

  it.each([
    ['gh pr create --title change', 'GitHub'],
    ['rtk gh pr merge 12', 'GitHub'],
    ['rtk git push origin HEAD', 'remote repository'],
    ['rtk proxy git push origin HEAD', 'remote repository'],
    ['rtk proxy rm -rf .', 'managed ticket worktree'],
    ['env GIT_DIR=/repo/.git rtk proxy git reset --hard', 'discard local work'],
    ['rtk proxy env GIT_DIR=/repo/.git git reset --hard', 'discard local work'],
    ['gh issue close 12', 'GitHub'],
    ['gh alias set x pr create', 'GitHub'],
    ['gh codespace ports visibility 3000:public -c my-codespace', 'GitHub'],
    ['gh extension exec custom', 'GitHub'],
    ['gh something-unknown', 'GitHub'],
    ['gh api /repos/owner/repo/issues -X POST', 'GitHub API'],
    ['gh api /repos/owner/repo/issues -f title=test', 'GitHub API'],
    ["gh api graphql -f query='mutation { createIssue }'", 'GraphQL mutation'],
    ["gh api graphql -f query='query Read { viewer { login } } mutation Write { updateViewer }' -F operationName=Write", 'GraphQL mutation'],
    ["gh api graphql -f query='query Read { viewer { login } },mutation Write { updateViewer(input:{bio:\"changed\"}) { clientMutationId } }' -F operationName=Write", 'GraphQL mutation'],
    ['gh api graphql --input request.json', 'unknown file'],
    ['cat request.json | gh api graphql', 'unknown pipe'],
    ['git push origin HEAD', 'remote repository'],
    ['git send-pack origin', 'remote repository'],
    ['git -C /repo/.looptroop/worktrees/T-1 -c user.name=bot reset --hard', 'discard local work'],
    ['git --git-dir=/repo/.git --work-tree=/tmp/scratch reset --hard', 'discard local work'],
    ['git --git-dir=/tmp/scratch/.git --work-tree=/repo reset --hard', 'discard local work'],
    ['GIT_DIR=/repo/.git GIT_WORK_TREE=/tmp/scratch git reset --hard', 'discard local work'],
    ['env GIT_DIR=/repo/.git GIT_WORK_TREE=/tmp/scratch git reset --hard', 'discard local work'],
    ['GIT_COMMON_DIR=/repo/.git git reset --hard', 'discard local work'],
    ['git -C /repo/.looptroop/worktrees/T-1 clean -fdx', 'remove local files'],
    ['git -C /repo/.looptroop/worktrees/T-1 rebase main', 'rewrite managed repository history'],
    ['git reset --hard', 'discard local work'],
    ['git -C /repo remote set-url origin https://example.test/repo', 'managed Git metadata'],
    ['git -C /repo worktree remove ../other', 'managed Git metadata'],
    ['git -C /repo config user.name bot', 'managed Git metadata'],
    ['git init --separate-git-dir=/repo/.git /tmp/scratch', 'Git metadata'],
    ['git clone --separate-git-dir /repo/.git https://example.test/repo.git /tmp/scratch', 'Git metadata'],
    ['git clone https://example.test/repo.git /repo/.looptroop/worktrees/T-2', 'managed LoopTroop state'],
    ['git -C /repo/.looptroop/worktrees/T-1 checkout .', 'managed ticket worktree'],
    ['tee .git/config', 'Git metadata'],
    ['cp src/config.json .git/config', 'Git metadata'],
    ['mv .git old-git', 'Git metadata'],
    ['mv src/config.json .git/config', 'Git metadata'],
    ['truncate -s 0 .ticket/runtime/execution-setup-profile.json', 'protected ticket runtime state'],
    ['npm test && gh pr merge 12', 'GitHub'],
  ])('rejects unsafe command: %s', (command, explanation) => {
    const rejection = shell(command)
    expect(rejection).toContain(explanation)
    expect(rejection).toContain('Continue local work; do not retry this action through another tool.')
  })

  it('inspects every scanner resource, including commands after shell operators', () => {
    expect(getPermissionGuardRejection({
      permission: 'shell',
      patterns: ['git status', 'gh pr view 12', 'git -c core.pager=cat push origin HEAD'],
      context,
    })).toContain('remote repository')
    expect(shell('git status && gh issue list && git -C /repo reset --hard')).toContain('discard local work')
  })

  it('protects the assigned directory without blocking independent scratch targets when context is absent', () => {
    const fallback = (command: string, directory = '/repo') => getPermissionGuardRejection({
      permission: 'bash',
      patterns: [command],
      directory,
    })
    expect(fallback('rm -rf .')).toContain('assigned execution directory')
    expect(fallback('git reset --hard')).toContain('discard local work')
    expect(fallback('rm -rf dist/*')).toBeNull()
    expect(fallback('git -C /tmp/scratch reset --hard')).toBeNull()
    expect(fallback('git clone https://example.test/scratch-repo.git', '/tmp')).toBeNull()
  })

  it('scopes context-free Git resets to the assigned and protected metadata paths', () => {
    const assigned = '/repo/.looptroop/worktrees/T-1'
    const fallback = (command: string) => getPermissionGuardRejection({
      permission: 'bash',
      patterns: [command],
      directory: assigned,
    })
    expect(fallback('git -C /tmp/scratch reset --hard')).toBeNull()
    expect(fallback('git --git-dir=/tmp/scratch/.git --work-tree=/tmp/scratch reset --hard')).toBeNull()
    expect(fallback('git reset --hard')).toContain('discard local work')
    expect(fallback('git -C /repo reset --hard')).toContain('discard local work')
    expect(fallback('git --git-dir=/repo/.git --work-tree=/tmp/scratch reset --hard')).toContain('discard local work')
    expect(getPermissionGuardRejection({ permission: 'bash', patterns: ['rm -rf .'], directory: assigned }))
      .toContain('assigned execution directory')
  })

  it('checks default clone destinations and separate Git metadata independently', () => {
    expect(shell('git clone https://example.test/T-2.git', { directory: '/repo/.looptroop/worktrees' }))
      .toContain('managed LoopTroop state')
    expect(shell('git init --separate-git-dir=/repo/.git /tmp/scratch')).toContain('Git metadata')
    expect(shell('git clone --separate-git-dir=/repo/.git https://example.test/repo.git /tmp/scratch'))
      .toContain('Git metadata')
  })

  it('protects direct file mutation destinations and move sources', () => {
    expect(shell('cp --target-directory=.git src/config.json')).toContain('Git metadata')
    expect(shell('Move-Item -Path .git -Destination old-git')).toContain('Git metadata')
    expect(shell('Copy-Item -Path src/config.json -Destination .ticket/runtime/execution-setup-profile.json'))
      .toContain('protected ticket runtime state')
    expect(shell('tee .ticket/runtime/execution-setup-profile.json')).toContain('protected ticket runtime state')
  })

  it('resolves directory destinations to each source basename', () => {
    expect(shell('cp src/config.json .')).toBeNull()
    expect(shell('mv src/README.md .')).toBeNull()
    expect(shell('cp -t . src/config.json')).toBeNull()
    expect(shell('cp --target-directory=. src/config.json')).toBeNull()
    expect(shell('cp src/config.json ./')).toBeNull()
    expect(shell('cp src/config.json ../', { directory: '/repo/src' })).toBeNull()
    expect(shell('cp src/config.json .git/')).toContain('Git metadata')
    expect(shell('mv .git/config .')).toContain('Git metadata')
  })

  it.each([
    ['.', 'managed ticket worktree'],
    ['..', 'managed ticket worktree'],
    ['*', 'managed'],
    ['.git', 'managed'],
    ['.ticket/prd.yaml', 'managed ticket state'],
    ['.looptroop/db.sqlite', 'managed LoopTroop state'],
    ['../worktrees/T-2', 'managed LoopTroop state'],
    ['/repo', 'managed'],
  ])('blocks broad removal of %s', (target, explanation) => {
    expect(shell(`rm -rf -- ${target}`)).toContain(explanation)
  })

  it.each([
    ['src/new.ts', null],
    ['.ticket/runtime/execution-setup/state.json', null],
    ['.ticket/runtime/tool-cache', null],
    ['.ticket/interview.yaml', 'managed ticket state'],
    ['.git/config', 'Git metadata'],
    ['.looptroop/tickets/T-2/state.json', 'managed LoopTroop state'],
    ['**', 'managed'],
  ])('classifies edit resource %s', (pattern, expected) => {
    const rejection = getPermissionGuardRejection({ permission: 'edit', patterns: [pattern], context })
    if (expected) expect(rejection).toContain(expected)
    else expect(rejection).toBeNull()
  })

  it('protects native apply_patch resources while allowing ordinary source paths', () => {
    expect(getPermissionGuardRejection({ permission: 'apply_patch', patterns: ['.git/config'], context }))
      .toContain('Git metadata')
    expect(getPermissionGuardRejection({ permission: 'apply_patch', patterns: ['src/new.ts'], context }))
      .toBeNull()
  })

  it.each([
    '.ticket/runtime',
    '.ticket/runtime/execution-log.jsonl',
    '.ticket/runtime/execution-log.debug.jsonl',
    '.ticket/runtime/execution-log.ai.jsonl',
    '.ticket/runtime/execution-setup-profile.json',
  ])('blocks edits to protected runtime state: %s', (pattern) => {
    expect(getPermissionGuardRejection({ permission: 'write', patterns: [pattern], context }))
      .toContain('protected ticket runtime state')
  })

  it.each([
    '.ticket/runtime',
    '.ticket/runtime/execution-log.jsonl',
    '.ticket/runtime/execution-log.debug.jsonl',
    '.ticket/runtime/execution-log.ai.jsonl',
    '.ticket/runtime/execution-setup-profile.json',
  ])('blocks removals of protected runtime state: %s', (target) => {
    expect(shell(`rm -rf ${target}`)).toContain('protected ticket runtime state')
  })

  it('handles Windows paths and allows only runtime setup files', () => {
    const windowsContext: PermissionGuardContext = {
      projectRoot: 'C:\\Repo',
      worktreePath: 'C:\\Repo\\.looptroop\\worktrees\\T-1',
      ticketDir: 'C:\\Repo\\.looptroop\\worktrees\\T-1\\.ticket',
    }
    expect(getPermissionGuardRejection({
      permission: 'write',
      patterns: ['C:\\REPO\\.LOOPTROOP\\WORKTREES\\T-1\\.TICKET\\runtime\\execution-setup\\tool-cache\\profile.json'],
      context: windowsContext,
    })).toBeNull()
    expect(getPermissionGuardRejection({
      permission: 'write',
      patterns: ['C:\\REPO\\.LOOPTROOP\\WORKTREES\\T-1\\.TICKET\\runtime\\EXECUTION-SETUP-PROFILE.JSON'],
      context: windowsContext,
    })).toContain('protected ticket runtime state')
    expect(getPermissionGuardRejection({
      permission: 'write',
      patterns: ['C:\\Repo\\.looptroop\\worktrees\\T-1\\.GIT\\config'],
      context: windowsContext,
    })).toContain('Git metadata')
    expect(shell('Remove-Item -Recurse -Force C:\\Repo\\.looptroop\\worktrees\\T-2', { context: windowsContext }))
      .toContain('managed LoopTroop state')
    expect(shell('rmdir /s /q C:\\Repo\\.looptroop\\worktrees\\T-1\\.ticket\\runtime', { context: windowsContext }))
      .toContain('protected ticket runtime state')
    expect(shell('Remove-Item -Recurse C:\\Repo\\.looptroop\\worktrees\\T-1\\.ticket\\runtime\\execution-setup\\tool-cache', { context: windowsContext }))
      .toBeNull()
  })

  it.each([
    { permission: 'bash' },
    { permission: 'shell', patterns: [] },
    { permission: 'edit' },
    { permission: 'write', patterns: [] },
  ])('rejects guarded requests without command or path resources: %o', (input) => {
    expect(getPermissionGuardRejection({ ...input, context })).toContain('cannot be verified')
  })

  it('uses native details as a fallback and leaves unrelated host paths alone', () => {
    expect(getPermissionGuardRejection({
      permission: 'bash',
      details: { patterns: ['gh pr merge 12'] },
      context,
    })).toContain('GitHub')
    expect(getPermissionGuardRejection({
      permission: 'write',
      patterns: ['/tmp/scratch/build/output.bin'],
      context,
    })).toBeNull()
    expect(getPermissionGuardRejection({ permission: 'external_directory', patterns: [] })).toBeNull()
  })
})
