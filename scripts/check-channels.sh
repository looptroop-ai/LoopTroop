#!/bin/sh
# Are the paused package channels usable yet?
#
#   npm run channels:check
#
# Chocolatey, WinGet and AUR publishing are switched off in release.yml because
# none of them can currently finish. Run this every few days. Read-only.
set -eu

echo
echo "== Chocolatey =="
# Blocked until one version is approved: Chocolatey answers 403 to a push for a
# package that has a version in moderation and no approved version.
versions=$(curl -sS --max-time 20 \
  "https://community.chocolatey.org/api/v2/FindPackagesById()?id='looptroop'" \
  | grep -o '<d:Version>[^<]*' | sed 's/<d:Version>//' | tr '\n' ' ')
if [ -n "$versions" ]; then
  echo "READY - approved: $versions"
  echo "  gh variable set PUBLISH_CHOCOLATEY --body true --repo looptroop-ai/LoopTroop"
else
  echo "blocked - still in moderation, nothing approved yet"
fi

echo
echo "== WinGet =="
# Blocked until the first pull request merges; after that `winget install` works
# and later versions are ordinary updates.
if curl -sSf --max-time 20 -o /dev/null \
  "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/l/LoopTroopAI/LoopTroop" 2>/dev/null
then
  echo "READY - published upstream"
  echo "  gh variable set PUBLISH_WINGET --body true --repo looptroop-ai/LoopTroop"
else
  echo "blocked - not upstream yet"
  gh pr list --repo microsoft/winget-pkgs --search LoopTroopAI.LoopTroop \
    --state all --limit 3 --json url,state,title \
    --template '{{range .}}  {{.state}}  {{.url}}{{"\n"}}{{end}}' 2>/dev/null \
    || echo "  (gh unavailable)"
fi

echo
echo "== AUR =="
# Blocked on registration reopening. Only the package is checked: the register
# page builds its form in JavaScript and answers 200 open or shut, so testing it
# would give a confident wrong answer.
if curl -sS --max-time 20 "https://aur.archlinux.org/rpc/v5/info?arg[]=looptroop-bin" \
  | grep -q '"resultcount":[1-9]'
then
  echo "READY - looptroop-bin exists"
  echo "  gh variable set PUBLISH_AUR --body true --repo looptroop-ai/LoopTroop"
else
  echo "blocked - not on the AUR yet"
  echo "  check by eye: https://aur.archlinux.org/register"
fi

echo
