import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
  it.each(['rm -r', 'restore', 'checkout', 'reset'])('checks exclusion-only pathspecs as a whole checkout for git %s', (command) => {
    for (const exclusion of [':!dist', ':^dist', ':(exclude)dist', ':(top,exclude)dist', ':(^)dist']) {
      expect(check(`git -C /repo ${command} -- '${exclusion}'`)).not.toBeNull()
      expect(check(`git ${command} -- '${exclusion}'`)).not.toBeNull()
      expect(check(`git -C /tmp/scratch ${command} -- '${exclusion}'`)).toBeNull()
      expect(check(`git ${command} -- src/file.ts '${exclusion}'`)).toBeNull()
    }
  })

  it.each([
    'git --namespace foo push origin HEAD', 'git --exec-path /tmp push origin HEAD',
    'git --exec-path=/tmp/evil status', 'git --exec-path /tmp/evil unknown-helper',
    'git --config-env user.name=NAME push origin HEAD', 'git lfs push origin HEAD',
    'git subtree --prefix=src push origin HEAD', 'git -c alias.ship=push ship origin HEAD',
    "git -calias.ship='!git push' ship", 'git $COMMAND origin HEAD',
    'git -c core.fsmonitor=helper status', 'git -c core.sshCommand=helper fetch',
    'git -c protocol.ext.allow=always ls-remote ext::printf',
    'git -c diff.foo.command=helper diff', 'git -c diff.foo.textconv=helper show HEAD',
    'git -c difftool.foo.cmd=helper difftool --tool=foo',
    'git config --global alias.ship push', 'git -C /tmp/scratch config --system core.hooksPath hooks',
    'git -C /tmp/scratch config --file /repo/.git/config core.hooksPath hooks',
    'git reset --soft HEAD~1', 'git reset HEAD~1', 'git branch -f main HEAD~1',
    'git checkout --force HEAD', 'git checkout -B ticket main', 'git switch -C ticket main',
    'git switch --discard-changes main', 'git rm -rf .', 'git rm .ticket/prd.yaml',
    'git rm -rf --ignore-unmatch -- . -n',
    'git mv .git/config /tmp/config', 'git rm --cached .',
    'git merge main', 'git pull origin main', 'git cherry-pick HEAD~1', 'git revert HEAD',
    'git am update.patch', 'git checkout-index -f -a', 'git read-tree --reset -u HEAD',
    'git filter-branch --force --tree-filter clean HEAD', 'git fast-import --force',
    "git restore --source=main --worktree --staged ':(top)'", 'git restore --source=main :/',
    'git replace HEAD HEAD~1', 'git notes add -m note', 'git reflog expire --expire=now --all',
    'git repack -Ad', 'git fetch --prune', 'git apply update.patch',
    "git clean -fdx -- ':!dist'", 'git clean -fdx -enode_modules',
    'git clean -fdx -- . --help', 'git clean -fdx -e -h',
    'git rm -rf --ignore-unmatch -- . -h',
    'git -C /repo stash apply', 'git -C /repo stash pop',
    'git -C /repo/.looptroop/worktrees/T-1 stash apply', 'git -C /repo/.looptroop/worktrees/T-1 stash pop',
    'git -C /repo add -A', 'git -C /repo commit -am change',
    'git fetch --upload-pack=helper origin', 'git archive --remote=origin --exec=helper',
    'git ls-remote ext::printf',
    'git --attr-source=HEAD push origin HEAD',
    'git clone -c protocol.ext.allow=always https://example.test/repo.git /tmp/scratch',
    'git clone --config core.sshCommand=evil https://example.test/repo.git /tmp/scratch',
    'git archive --output=.git/archive.tar HEAD', 'git diff --output=.git/config',
    'git bundle create .git/backup.bundle --all', 'git diff --output=$OUTPUT',
    'git submodule init', 'git submodule sync', 'git lfs install',
    'git subtree pull origin main --prefix=vendor', 'git svn dcommit',
    'git push /repo/.git main', 'git push /repo/.looptroop/worktrees/T-2/.git main',
    'git push --repo=/tmp/scratch /repo/.git HEAD',
    'git init .', 'gh repo clone owner/repo .',
    'gh repo clone -u upstream owner/repo /repo/.looptroop/worktrees/T-2',
    'gh repo clone owner/repo /tmp/scratch -- --separate-git-dir=/repo/.git',
    "su -c 'rm -rf /repo/.git'", 'runuser -u root -- rm -rf /repo/.git',
    'gosu root rm -rf /repo/.git', 'chroot /tmp/root /bin/rm -rf /repo/.git',
    "nsenter --mount=/proc/1/ns/mnt sh -c 'rm -rf /repo/.git'",
    'ln -sf payload /repo/.git/hooks/pre-commit', 'ln -h -sf /tmp/replacement /repo/.git/config',
    'link payload /repo/.git/config',
    'mklink /repo/.git/config payload', 'tar -xzf archive.tar -C /repo/.git',
    'unzip archive.zip -d /repo/.git', '7z x archive.7z -o/repo/.git',
    'cpio -idm -D /repo/.git', 'cpio -p /repo/.git', 'cpio -oF /repo/.git/archive.cpio',
    'tar -cf /repo/.git/archive.tar file.txt', 'tar -h -xf archive.tar -C /repo',
  ])('refuses unsafe Git shape: %s', (command) => {
    expect(check(command)).not.toBeNull()
  })

  it.each(['rm -r', 'restore', 'checkout', 'reset'])('checks exclusion-only pathspecs as a whole checkout for git %s', (command) => {
    for (const exclusion of [':!dist', ':^dist', ':(exclude)dist', ':(top,exclude)dist', ':(^)dist']) {
      expect(check(`git -C /repo ${command} -- '${exclusion}'`)).not.toBeNull()
      expect(check(`git ${command} -- '${exclusion}'`)).not.toBeNull()
      expect(check(`git -C /tmp/scratch ${command} -- '${exclusion}'`)).toBeNull()
      expect(check(`git ${command} -- src/file.ts '${exclusion}'`)).toBeNull()
    }
  })

  it.each([
    'git --namespace foo status', 'git config --global user.name',
    'git config --show-origin user.name', 'git config --global --get alias.ship',
    'git config --list', 'git config get user.name', 'git branch --list',
    'git tag --list', 'git notes list', 'git reflog show',
    'git add src/a.ts && git commit -m change', 'git checkout -- src/a.ts',
    'git reset -- src/a.ts', 'git rm src/old.ts', 'git mv src/old.ts src/new.ts',
    'git clean --help', 'git status -h',
    'git clean -fd -- src/generated', 'git clean -ndx', 'git clean -fdx -n -- .',
    'git clean -fdx -e node_modules -- src/generated', 'git apply --check update.patch',
    'git -C /repo status --short',
    'git push --dry-run origin main',
    'git -C /tmp/scratch reset --hard', 'git -C /tmp/scratch switch -C main',
    'git -C /tmp/scratch config user.name Test', 'git init /tmp/scratch',
    'git -C /tmp/scratch merge main', 'git -C /tmp/scratch pull origin main',
    'git -C /tmp/scratch cherry-pick HEAD~1', 'git -C /tmp/scratch revert HEAD',
    'git -C /tmp/scratch am update.patch', 'git -C /tmp/scratch checkout-index -f -a',
    'git -C /tmp/scratch read-tree --reset -u HEAD',
    'git -C /tmp/scratch filter-branch --force --tree-filter clean HEAD',
    'git -C /tmp/scratch fast-import --force',
    'git -C /tmp/scratch stash apply', 'git -C /tmp/scratch stash pop',
    'GIT_PAGER=less git --paginate log', 'GIT_TRACE=2 git status',
    'GIT_TRACE=/tmp/git-trace.log git status',
    'PAGER=less git --paginate log',
    'git clone -c user.name=LoopTroop https://example.test/repo.git /tmp/scratch',
    'git clone https://example.test/repo.git /tmp/scratch',
    'tar -cf archive.tar xdata',
    'rm --help', 'rm --version',
    'gh repo clone owner/repo /tmp/scratch -- --depth=1',
    'unzip archive.zip -d /tmp/unpacked', 'unzip -p archive.zip file.txt',
    '7z x archive.7z -o/tmp/unpacked',
  ])('keeps safe reads and ordinary local work available: %s', (command) => {
    expect(check(command)).toBeNull()
  })

  it.each([
    ['git push ./scratch --repo=origin', 'destination cannot be verified'],
    ['git -c url.https://example.test/.pushInsteadOf=./ push ./scratch', 'URL rewriting'],
    ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://example.test/.pushInsteadOf GIT_CONFIG_VALUE_0=./ git push ./scratch', 'URL rewriting'],
    ["GIT_PAGER='gh pr merge 12' git --paginate log", 'GitHub'],
    ['GIT_TRACE=/repo/.git/config git status', 'Git metadata'],
    ['GIT_TRACE=../../../.git/config git status', 'Git metadata'],
    ['git push --receive-pack=helper /tmp/scratch', 'external receive-pack'],
    ['git push --exec=helper /tmp/scratch', 'external receive-pack'],
    ['git fetch --upload-pack=helper origin', 'external upload-pack'],
    ['git receive-pack /repo/.git', 'Git metadata'],
    ['git fetch origin +refs/heads/main:refs/looptroop/pull-heads/42/head', 'LoopTroop refs'],
    ['git -c remote.origin.fetch=+refs/heads/main:refs/looptroop/pull-heads/42/head fetch origin', 'LoopTroop refs'],
    ['git merge-file .git/config base other', 'Git metadata'],
    ['GIT_SSH_VARIANT=ssh git fetch origin', 'external command'],
    ['GIT_EDITOR=helper git add -e src/file.ts', 'external command'],
  ])('refuses direct Git helper or protected-ref bypass: %s', (command, explanation) => {
    expect(check(command)).toContain(explanation)
  })

  it('checks literal PAGER changes while keeping safe pager commands available', () => {
    const previousGitPager = process.env.GIT_PAGER
    delete process.env.GIT_PAGER
    try {
      expect(check("PAGER='gh pr merge 12' git --paginate log")).toContain('GitHub')
      expect(check("export PAGER='gh pr merge 12'; git --paginate log")).toContain('GitHub')
      expect(check("$env:PAGER='gh pr merge 12'; git --paginate log")).toContain('GitHub')
      expect(check("export PAGER='less'; git --paginate log")).toBeNull()
      expect(check("$env:PAGER='less'; git --paginate log")).toBeNull()
    } finally {
      if (previousGitPager === undefined) delete process.env.GIT_PAGER
      else process.env.GIT_PAGER = previousGitPager
    }
  })

  it('requires a known directory for relative Git mutations', () => {
    expect(check('git reset --hard', true)).not.toBeNull()
    expect(check('git -C /tmp/scratch reset --hard', true)).toBeNull()
    expect(check('git status', true)).toBeNull()
  })

  it('blocks Git and GitHub when executable lookup or loader settings change', () => {
    expect(check('PATH=/tmp/evil git status')).toContain('executable cannot be verified')
    expect(check('export PATH=/tmp/evil; gh pr view 12')).toContain('executable cannot be verified')
    expect(check('LD_PRELOAD=/tmp/payload.so gh pr view 12')).toContain('executable cannot be verified')
    expect(check('GIT_EXEC_PATH=/tmp/payload git custom-helper')).toContain('executable cannot be verified')
    expect(check('export GIT_EXEC_PATH=/tmp/payload; git custom-helper')).toContain('executable cannot be verified')
    expect(check('/tmp/evil/git status')).toContain('executable cannot be verified')
    expect(check('export PATH=/tmp/evil; npm test')).toBeNull()
  })

  it('blocks GitHub pager and browser helpers while keeping ordinary reads available', () => {
    expect(check('GH_PAGER=/tmp/payload.sh GH_FORCE_TTY=1 gh pr diff 12')).toContain('GitHub pager')
    expect(check('GH_PAGER=cat gh pr diff 12')).toBeNull()
    expect(check('gh pr view 12 --web')).toContain('GitHub browser')
    expect(check('GH_BROWSER=/tmp/payload.sh gh pr view 12 --web')).toContain('GitHub browser')
    expect(check('BROWSER=/tmp/payload.sh gh pr view 12 --web')).toContain('GitHub browser')
    expect(check('GH_CONFIG_DIR=/tmp/gh-config gh pr view 12 --web')).toContain('GitHub browser')
    expect(check('GH_CONFIG_DIR=/tmp/gh-config gh pr view 12')).toBeNull()
    expect(check('gh --config pager=/tmp/payload.sh pr view 12')).toContain('GitHub pager')
    expect(check('gh pr view 12 --config pager=/tmp/payload.sh')).toContain('GitHub pager')
    expect(check('gh pr view 12 --config pager=cat')).toBeNull()
    expect(check('gh pr diff 12 --config pager=cat')).toBeNull()
    expect(check('gh --config pager=cat pr diff 12')).toBeNull()
    expect(check('gh pr view 12 --config browser=/tmp/payload.sh --web')).toContain('GitHub browser')
    expect(check('GH_BROWSER=/tmp/payload.sh gh pr view 12 --web=true')).toContain('GitHub browser')
    expect(check('BROWSER=/tmp/payload.sh gh pr view 12 -w=true')).toContain('GitHub browser')
    expect(check('gh pr view 12')).toBeNull()
  })

  it('checks inherited GitHub helpers and commands that can create a terminal', () => {
    const names = ['GH_PAGER', 'PAGER', 'GH_FORCE_TTY', 'GH_CONFIG_DIR'] as const
    try {
      for (const name of names) vi.stubEnv(name, undefined)
      expect(check('script -- gh pr diff 12')).toContain('pager configuration')
      expect(check("script -c 'gh pr diff 12' /dev/null")).toContain('pager configuration')
      expect(check("script -c 'GH_PAGER=cat gh pr diff 12' /dev/null")).toBeNull()
      expect(check('unbuffer -p gh pr diff 12')).toContain('pager configuration')
      expect(check('watch gh pr diff 12')).toContain('pager configuration')

      process.env.GH_CONFIG_DIR = '/tmp/gh-config'
      expect(check('script -- gh pr diff 12')).toContain('pager configuration')
      process.env.GH_PAGER = '/tmp/payload.sh'
      expect(check('gh pr view 12')).toContain('GitHub pager')
      process.env.GH_PAGER = 'cat'
      expect(check('gh pr view 12')).toBeNull()
      expect(check("export GH_PAGER='/tmp/payload.sh'; gh pr view 12")).toContain('GitHub pager')
      expect(check('export GH_PAGER=cat; gh pr view 12')).toBeNull()
      expect(check("$env:GH_PAGER='/tmp/payload.sh'; gh pr view 12")).toContain('GitHub pager')
      expect(check('$env:GH_PAGER=cat; gh pr view 12')).toBeNull()
      expect(check('export GH_FORCE_TTY=1; gh pr view 12')).toContain('forced GitHub terminal output')
      expect(check('$env:GH_FORCE_TTY=1; gh pr view 12')).toContain('forced GitHub terminal output')
      expect(check('GH_PAGER=cat GH_FORCE_TTY=1 gh pr view 12')).toContain('forced GitHub terminal output')
      delete process.env.GH_PAGER
      process.env.PAGER = '/tmp/payload.sh'
      expect(check('gh pr view 12')).toContain('GitHub pager')
      process.env.PAGER = 'cat'
      process.env.GH_FORCE_TTY = '1'
      expect(check('gh pr view 12')).toContain('forced GitHub terminal output')

      process.env.GH_PAGER = 'cat'
      expect(check('env -u GH_PAGER PAGER=/tmp/payload.sh script -- gh pr diff 12')).toContain('GitHub pager')
      expect(check('env -u GH_PAGER -u GH_FORCE_TTY PAGER=cat script -- gh pr diff 12')).toBeNull()
      expect(check('env -i GH_PAGER=cat script -- gh pr diff 12')).toBeNull()
      expect(check('env -i PAGER=/tmp/payload.sh script -- gh pr diff 12')).toContain('GitHub pager')
      expect(check('env -i script -- gh pr diff 12')).toContain('pager configuration')
      expect(check("env -S '-u GH_PAGER PAGER=/tmp/payload.sh script -- gh pr diff 12'")).toContain('GitHub pager')
      expect(check('env -u GH_FORCE_TTY GH_PAGER=cat gh pr view 12')).toBeNull()
      process.env.GH_PAGER = '/tmp/payload.sh'
      const lowerCaseUnset = check('env -u gh_pager -u GH_FORCE_TTY PAGER=cat script -- gh pr diff 12')
      if (process.platform === 'win32') expect(lowerCaseUnset).toBeNull()
      else expect(lowerCaseUnset).toContain('GitHub pager')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('protects the Git index path and permits scratch indexes', () => {
    expect(check('GIT_INDEX_FILE=/repo/.git/index git add -A')).toContain('Git metadata')
    expect(check('GIT_INDEX_FILE=/tmp/scratch/index git -C /tmp/scratch add -A')).toBeNull()
  })

  it('checks effective fetch refspecs only for the selected remote and when they apply', ({ onTestFinished }) => {
    const root = mkdtempSync(join(tmpdir(), 'looptroop-guard-fetch-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'remote.origin.url', 'https://example.test/origin.git'])
    execFileSync('git', ['-C', root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/looptroop/pull-heads/*'])
    execFileSync('git', ['-C', root, 'config', 'remote.upstream.url', 'https://example.test/upstream.git'])
    execFileSync('git', ['-C', root, 'config', 'remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*'])
    const localCheck = (command: string) => getPermissionGuardRejection({
      permission: 'bash', patterns: [command], directory: root,
      context: { projectRoot: root, worktreePath: root, ticketDir: join(root, '.ticket') },
    })

    expect(localCheck('git fetch upstream')).toBeNull()
    expect(localCheck('git fetch origin')).toContain('LoopTroop refs')
    expect(localCheck('git fetch --refmap=refs/heads/*:refs/remotes/origin/* origin')).toContain('LoopTroop refs')
    expect(localCheck('git fetch --refmap=refs/heads/*:refs/remotes/origin/* origin main')).toBeNull()
  })

  it('checks inherited Git trace destinations against protected paths', () => {
    const previousTrace = process.env.GIT_TRACE
    process.env.GIT_TRACE = '/repo/.git/config'
    try {
      expect(check('git status')).toContain('Git metadata')
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE
      else process.env.GIT_TRACE = previousTrace
    }
  })

  it('checks the fallback pager after GIT_PAGER is unset', () => {
    const previousGitPager = process.env.GIT_PAGER
    const previousPager = process.env.PAGER
    process.env.GIT_PAGER = 'less'
    process.env.PAGER = 'gh pr merge 12'
    try {
      expect(check('unset GIT_PAGER; git --paginate log')).toContain('GitHub')
    } finally {
      if (previousGitPager === undefined) delete process.env.GIT_PAGER
      else process.env.GIT_PAGER = previousGitPager
      if (previousPager === undefined) delete process.env.PAGER
      else process.env.PAGER = previousPager
    }
  })

  it('blocks Git output paths that can escape a scratch repository through shell expansion', () => {
    expect(getPermissionGuardRejection({ permission: 'bash', patterns: ['git -C /tmp/scratch diff --output=$OUTPUT'], context }))
      .toContain('Git output path cannot be verified')
  })
})

describe('workflow guard request boundaries', () => {
  it.each([
    ['gh api', 'endpoint cannot be verified'],
    ['gh api repos/owner/repo --header', 'method cannot be verified'],
    ['gh api repos/owner/repo --field malformed', 'fields cannot be verified'],
    ['gh api repos/owner/repo --field=malformed', 'fields cannot be verified'],
    ['gh api repos/owner/repo --field body=@payload.json', 'unknown file'],
    ['gh api repos/owner/repo --raw-field=body=@payload.json', 'unknown file'],
    ['gh repo clone', 'clone destination cannot be verified'],
    ['gh repo clone owner/repo /tmp/one /tmp/two', 'clone destination cannot be verified'],
    ['gh repo clone --unknown owner/repo /tmp/scratch', 'clone options cannot be verified'],
    ['gh release download v1 --dir', 'download destination cannot be verified'],
    ['git rm --pathspec-from-file paths.txt', 'Git pathspec cannot be verified'],
    ['git mv src/only.ts', 'Git pathspec cannot be verified'],
    ['git clean -fd --exclude', 'Git clean target cannot be verified'],
    ['git clean -fd --unknown-option', 'Git clean target cannot be verified'],
    ['rsync --log-file', 'rsync option cannot be verified'],
    ['rsync --files-from files.txt --remove-source-files src/ dist/', 'removal source paths cannot be verified'],
    ['rsync -avT/repo/.looptroop/worktrees/T-1/.ticket src/ /tmp/scratch/', 'ticket state'],
  ])('refuses incomplete or indirect mutation targets: %s', (command, reason) => {
    expect(check(command)).toContain(reason)
  })

  it.each([
    '"unterminated',
    '{ viewer { login } }}',
    '{ viewer { login }',
    'subscription Events { viewer { login } }',
    'fragment Fields on User { login }',
  ])('refuses a GraphQL document without a complete read operation: %s', (query) => {
    expect(check(`gh api graphql --field 'query=${query}'`)).toContain('GraphQL operation cannot be verified')
  })

  it.each([
    '# mutation is only a comment\nquery Read { viewer { login } }',
    'query Read { viewer { bio(text: """mutation { notAnOperation }""") } }',
    'query Read { viewer { ...Fields } } fragment Fields on User { login }',
  ])('keeps quoted text and fragments inside a read-only GraphQL document: %s', (query) => {
    expect(check(`gh api graphql --raw-field 'query=${query}'`)).toBeNull()
  })

  it('keeps explicit HEAD requests and directory-scoped Git moves available', () => {
    expect(check("gh api repos/owner/repo --method=HEAD --include --cache 1h --jq='.name'")).toBeNull()
    expect(check('git mv src/old.ts src/older.ts dist/')).toBeNull()
    expect(check('git mv src/old.ts .ticket/')).toContain('ticket state')
  })
})
