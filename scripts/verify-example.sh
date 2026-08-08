#!/usr/bin/env bash
# Runs examples/node-wallet against a PACKED tarball, not the source tree.
#
# The tarball is the honest check: a workspace link resolves src/ directly and
# would hide a broken `exports` map or an incomplete `files` list — exactly the
# failures that only show up after publishing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
npm run build
TARBALL="$ROOT/$(npm pack --silent)"
trap 'rm -rf "$WORK" "$TARBALL"' EXIT

cp -r "$ROOT/examples/node-wallet/." "$WORK/"
cd "$WORK"
# Point the example at the tarball instead of the workspace.
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies['@orbinum/sdk'] = 'file:$TARBALL';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"
pnpm install --silent
pnpm exec tsc --noEmit
pnpm start
# The portability check must not touch a browser API. Running it with those
# globals defined would let one slip in unnoticed.
pnpm portability
# The spend path must be wirable from the facade alone. This is the check that
# fails if a dependency stops being obtainable without reaching around it.
pnpm spend
