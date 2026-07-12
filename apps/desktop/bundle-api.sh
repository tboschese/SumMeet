#!/usr/bin/env bash
# Packages the API into the .app so it runs without pnpm, without tsx and without the
# repo. Called by bundle.sh; the output lands in SumMeet.app/Contents/Resources/api.
#
# What has to travel:
#   • the server itself, bundled by esbuild into one file;
#   • Prisma — its generated client and a *native* query engine, which cannot be
#     bundled and must sit in node_modules where the client looks for it;
#   • a Node runtime, because a shipped app cannot assume the user has one;
#   • a migrated, empty database, copied to the user's data dir on first run. Shipping
#     the schema instead would mean shipping the Prisma CLI to apply it.
#
# ffmpeg stays an external dependency (the recorder shells out to it); it is on PATH
# via augmented_path().
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
APP="${1:-$HERE/build/SumMeet.app}"
OUT="$APP/Contents/Resources/api"
ESBUILD_VERSION="0.24.0"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "  → bundling the server"
# Some dependencies still call require() at runtime. In an ESM bundle esbuild turns
# that into a stub that throws ("Dynamic require of \"fs\" is not supported"), so give
# them a real one.
BANNER='import{createRequire as __cr}from"module";const require=__cr(import.meta.url);'
(cd "$ROOT" && pnpm dlx "esbuild@$ESBUILD_VERSION" apps/api/src/server.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --external:@prisma/client --external:.prisma/client \
  --banner:js="$BANNER" \
  --outfile="$OUT/server.mjs") >/dev/null 2>&1
test -s "$OUT/server.mjs" || { echo "✗ esbuild produced no server.mjs" >&2; exit 1; }

echo "  → copying Prisma's client and native engine"
# The generated client resolves `.prisma/client` from node_modules next to itself, so
# both have to keep that layout — a flat copy silently breaks at runtime.
PRISMA_CLIENT="$(cd "$ROOT/apps/api" && node -e "
  const p = require.resolve('@prisma/client/package.json');
  console.log(require('node:path').dirname(p));
")"
# .prisma sits beside @prisma inside the same node_modules, not inside @prisma itself.
GENERATED="$(dirname "$(dirname "$PRISMA_CLIENT")")/.prisma"

mkdir -p "$OUT/node_modules/@prisma"
cp -R "$PRISMA_CLIENT" "$OUT/node_modules/@prisma/client"
test -d "$GENERATED" || { echo "✗ .prisma/client not found — run pnpm db:generate" >&2; exit 1; }
cp -R "$GENERATED" "$OUT/node_modules/.prisma"

ENGINE="$(find "$OUT/node_modules/.prisma" -name "libquery_engine*.node" | head -1)"
test -n "$ENGINE" || { echo "✗ no Prisma query engine in the copied client" >&2; exit 1; }

echo "  → copying the Node runtime"
NODE_BIN="$(command -v node)"
test -x "$NODE_BIN" || { echo "✗ node not found on PATH" >&2; exit 1; }
cp "$NODE_BIN" "$OUT/node"
chmod +x "$OUT/node"

echo "  → creating the database template"
# An empty database with every migration applied. The app copies it to the user's data
# directory the first time it runs, so a fresh install has a schema without shipping the
# Prisma CLI to build one.
TEMPLATE_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMPLATE_DIR"' EXIT
(cd "$ROOT/apps/api" && \
  DATABASE_URL="file:$TEMPLATE_DIR/summeet.db" \
  pnpm exec prisma migrate deploy) >/dev/null 2>&1
test -s "$TEMPLATE_DIR/summeet.db" || { echo "✗ could not build the database template" >&2; exit 1; }
cp "$TEMPLATE_DIR/summeet.db" "$OUT/summeet.template.db"

echo "  ✓ api packaged ($(du -sh "$OUT" | cut -f1))"
