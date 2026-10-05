#!/usr/bin/env bash
# Creates a git repository from fixtures/<name> with a base commit and one
# scenario commit, for integration tests on real runners.
# Usage: scripts/make-fixture.sh <fixture> <dest> <file-to-change>...
set -euo pipefail
fixture="$1"; dest="$2"; shift 2
src="$(cd "$(dirname "$0")/.." && pwd)/fixtures/$fixture"
rm -rf "$dest"; mkdir -p "$dest"
cp "$src/dynamic-monorepo.config.json" "$dest/dynamic-monorepo.config.json"
cd "$dest"
git init -q -b main
git config user.email ci@example.com
git config user.name ci
# One source file per project directory declared in the config.
for dir in $(node -e 'const c=require("./dynamic-monorepo.config.json");for(const p of Object.values(c.projects))console.log(p.path)'); do
  mkdir -p "$dir"; echo "export {}" > "$dir/index.ts"
done
echo '{}' > package-lock.json
git add -A; git commit -q -m base
for f in "$@"; do mkdir -p "$(dirname "$f")"; echo "// change" >> "$f"; done
git add -A; git commit -q --allow-empty -m scenario
