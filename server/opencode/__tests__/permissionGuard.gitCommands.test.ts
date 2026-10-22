import { describe, expect, it } from 'vitest'
import { getPermissionGuardRejection } from '../permissionGuard'

const context = {
  projectRoot: '/repo',
  worktreePath: '/repo/.looptroop/worktrees/T-1',
  ticketDir: '/repo/.looptroop/worktrees/T-1/.ticket',
}
const check = (command: string, unverifiedDirectory = false) => getPermissionGuardRejection({
  permission: 'bash', patterns: [command], context, unverifiedDirectory,
})

describe('recognized Git commands in the workflow guard', () => {
  it.each([
    'git --namespace foo push origin HEAD', 'git --exec-path /tmp push origin HEAD',
    'git --config-env user.name=NAME push origin HEAD', 'git lfs push origin HEAD',
    'git subtree --prefix=src push origin HEAD', 'git -c alias.ship=push ship origin HEAD',
    "git -calias.ship='!git push' ship", 'git $COMMAND origin HEAD',
    'git -c core.fsmonitor=helper status', 'git -c core.sshCommand=helper fetch',
    'git config --global alias.ship push', 'git -C /tmp/scratch config --system core.hooksPath hooks',
    'git -C /tmp/scratch config --file /repo/.git/config core.hooksPath hooks',
    'git reset --soft HEAD~1', 'git reset HEAD~1', 'git branch -f main HEAD~1',
    'git checkout --force HEAD', 'git checkout -B ticket main', 'git switch -C ticket main',
    'git switch --discard-changes main', 'git rm -rf .', 'git rm .ticket/prd.yaml',
    'git mv .git/config /tmp/config', 'git rm --cached .',
    "git restore --source=main --worktree --staged ':(top)'", 'git restore --source=main :/',
    'git replace HEAD HEAD~1', 'git notes add -m note', 'git reflog expire --expire=now --all',
    'git repack -Ad', 'git fetch --prune', 'git apply update.patch',
    'git init .', 'gh repo clone owner/repo .',
    'gh repo clone -u upstream owner/repo /repo/.looptroop/worktrees/T-2',
    'gh repo clone owner/repo /tmp/scratch -- --separate-git-dir=/repo/.git',
  ])('refuses unsafe Git shape: %s', (command) => {
    expect(check(command)).not.toBeNull()
  })

  it.each([
    'git --namespace foo status', 'git config --global user.name',
    'git config --show-origin user.name', 'git config --global --get alias.ship',
    'git config --list', 'git config get user.name', 'git branch --list',
    'git tag --list', 'git notes list', 'git reflog show', 'git fetch origin',
    'git add src/a.ts && git commit -m change', 'git checkout -- src/a.ts',
    'git reset -- src/a.ts', 'git rm src/old.ts', 'git mv src/old.ts src/new.ts',
    'git clean -fd -- src/generated', 'git clean -ndx', 'git apply --check update.patch',
    'git -C /tmp/scratch reset --hard', 'git -C /tmp/scratch switch -C main',
    'git -C /tmp/scratch config user.name Test', 'git init /tmp/scratch',
    'git clone https://example.test/repo.git /tmp/scratch',
    'gh repo clone owner/repo /tmp/scratch -- --depth=1',
  ])('keeps safe reads and ordinary local work available: %s', (command) => {
    expect(check(command)).toBeNull()
  })

  it('requires a known directory for relative Git mutations', () => {
    expect(check('git reset --hard', true)).not.toBeNull()
    expect(check('git -C /tmp/scratch reset --hard', true)).toBeNull()
    expect(check('git status', true)).toBeNull()
  })
})
