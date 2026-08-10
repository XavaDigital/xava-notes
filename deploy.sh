#!/usr/bin/env sh
# Deploy Xava Notes: run pre-flight checks, then push.
#
# Pushing IS the deploy — .github/workflows/pages.yml publishes the repo root to
# GitHub Pages on every push to the deploy branch. So the checks below are the
# only thing standing between a mistake and the live app on your phone.
#
# Usage:
#   sh deploy.sh            # check, then push
#   sh deploy.sh --check    # check only, never push
#
# Exits non-zero on the first failed check, without pushing.

set -eu

BRANCH="claude/note-todo-app-fnaar3"   # the branch pages.yml deploys from
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail() { printf '\n  FAILED: %s\n\n' "$1" >&2; exit 1; }
step() { printf '  %-46s' "$1"; }
ok()   { printf 'ok\n'; }

cd "$(dirname "$0")"
printf '\nXava Notes deploy checks\n\n'

# 1. Right branch. Pushing anything else deploys nothing, which is a confusing
#    way to find out you were on the wrong branch.
step "on the deploy branch"
current="$(git rev-parse --abbrev-ref HEAD)"
[ "$current" = "$BRANCH" ] || fail "on '$current', expected '$BRANCH'"
ok

# 2. No half-finished merge.
step "no unresolved merge"
[ -z "$(git diff --name-only --diff-filter=U)" ] || fail "unmerged paths remain: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"
ok

# 3. No conflict markers left in the source. A stray marker parses as a syntax
#    error in JS but sails straight through in CSS and HTML.
step "no conflict markers in source"
markers="$(git grep -l -E '^(<<<<<<< |>>>>>>> |=======$)' -- '*.js' '*.css' '*.html' '*.json' '*.webmanifest' 2>/dev/null || true)"
[ -z "$markers" ] || fail "conflict markers in: $(echo "$markers" | tr '\n' ' ')"
ok

# 4. Nothing uncommitted. What gets deployed is what's committed, so an
#    uncommitted edit means the live site won't match this working copy.
step "working tree clean"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "uncommitted changes — commit them first:
$(git status --short --untracked-files=no)"
ok

# 5. Secrets stay local. .env holds the Worker/Mailgun credentials.
step ".env not tracked"
git ls-files --error-unmatch .env >/dev/null 2>&1 && fail ".env is tracked by git — remove it from the index before deploying"
ok

# 6. Every JS file parses. Catches the class of mistake that would otherwise
#    show up as a blank screen on the phone.
step "javascript parses"
for f in js/*.js sw.js; do
  node --check "$f" >/dev/null 2>&1 || fail "$f does not parse — run: node --check $f"
done
ok

# 7. The service worker cache version must change whenever shipped code does,
#    or returning devices can keep serving the old shell from cache.
step "service worker cache bumped"
git fetch --quiet origin "$BRANCH" 2>/dev/null || true
if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  changed="$(git diff --name-only "origin/$BRANCH" HEAD -- js css index.html manifest.webmanifest || true)"
  if [ -n "$changed" ]; then
    old="$(git show "origin/$BRANCH:sw.js" 2>/dev/null | sed -n "s/^const CACHE = '\(.*\)';$/\1/p")"
    new="$(sed -n "s/^const CACHE = '\(.*\)';$/\1/p" sw.js)"
    [ -n "$new" ] || fail "could not read CACHE from sw.js"
    [ "$old" != "$new" ] || fail "shipped code changed but sw.js CACHE is still '$new' — bump it"
  fi
fi
ok

# 8. Nothing to do is worth saying out loud rather than reporting success.
step "has something to push"
if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  ahead="$(git rev-list --count "origin/$BRANCH..HEAD")"
  [ "$ahead" -gt 0 ] || fail "nothing to push — HEAD matches origin/$BRANCH"
fi
ok

printf '\nAll checks passed.\n'

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf 'Check-only mode; not pushing.\n\n'
  exit 0
fi

printf '\nPushing %s commit(s) to origin/%s...\n\n' "${ahead:-?}" "$BRANCH"
git push origin "$BRANCH"

remote_url="$(git remote get-url origin | sed 's/\.git$//')"
printf '\nPushed. GitHub Pages builds automatically:\n'
printf '  Progress: %s/actions\n' "$remote_url"
printf '\nOn the phone, fully close and reopen the app while online — the service\n'
printf 'worker is network-first, so a reload picks up the new code.\n\n'
