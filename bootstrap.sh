#!/usr/bin/env bash
# Keyring — one-shot repo setup (Linux/macOS equivalent of bootstrap.ps1).
set -euo pipefail
cd "$(dirname "$0")"

REPO="${1:-keyring-vault}"
VIS="${VISIBILITY:---private}"

command -v git >/dev/null || { echo "git is not installed"; exit 1; }

if command -v gh >/dev/null; then
  gh auth status >/dev/null 2>&1 || gh auth login
  OWNER="$(gh api user --jq .login)"
else
  read -rp "Your GitHub username: " OWNER
fi

[ -f README.md ] && sed -i.bak "s/OWNER_PLACEHOLDER/$OWNER/g" README.md && rm -f README.md.bak

if [ -f ci-workflow.yml ]; then
  if [ -f .github/workflows/ci.yml ]; then
    rm -f ci-workflow.yml
  else
    mkdir -p .github/workflows && mv ci-workflow.yml .github/workflows/ci.yml
    echo "installed .github/workflows/ci.yml"
  fi
fi

[ -d .git ] || git init -b main >/dev/null
git add -A
git diff --cached --quiet || git commit -q -m "Keyring: self-hosted encrypted API key vault"

if git ls-files | grep -Eq 'vault\.json$|keyring-(backup|PLAINTEXT)-.*\.json$'; then
  echo "Refusing to push: real vault data is staged."; exit 1
fi

if command -v gh >/dev/null; then
  git remote get-url origin >/dev/null 2>&1 \
    && git push -u origin main \
    || gh repo create "$REPO" "$VIS" --source=. --remote=origin --push
  echo "Done: https://github.com/$OWNER/$REPO"
else
  echo "Create $REPO at https://github.com/new, then:"
  echo "  git remote add origin https://github.com/$OWNER/$REPO.git"
  echo "  git push -u origin main"
fi
