#!/usr/bin/env bash
# Smoke test of the running compose stack (`docker compose up --wait` first). Used by the CI docker
# job and runnable locally: `pnpm smoke:docker`. The browser-level check is `pnpm --filter @ow/web smoke`.
set -euo pipefail

base=${SMOKE_BASE_URL:-http://localhost:8080}
tracks_budget_bytes=$((600 * 1024))
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Git Bash on Windows: hand native tools (curl) a Windows path. No-op on Linux and macOS.
if command -v cygpath >/dev/null; then tmp=$(cygpath -m "$tmp"); fi

fail() {
  echo "✖ $*" >&2
  exit 1
}
ok() { echo "✔ $*"; }
header() { grep -i "^$1:" "$2" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

# --- Static app ---------------------------------------------------------------------------------
curl -fsS "$base/healthz" >/dev/null || fail 'nginx /healthz'
curl -fsS -D "$tmp/index.h" -o "$tmp/index.html" "$base/"
grep -q '<div id="root">' "$tmp/index.html" || fail 'index.html is not the app'
header content-security-policy "$tmp/index.h" | grep -q "script-src 'self'" || fail 'CSP missing on /'
[ "$(header cache-control "$tmp/index.h")" = 'no-cache' ] || fail 'index.html must revalidate'
ok 'index.html: app, CSP, no-cache'

entry=$(grep -o '/assets/index-[^"]*\.js' "$tmp/index.html" | head -1)
[ -n "$entry" ] || fail 'no entry script in index.html'
curl -fsS -D "$tmp/entry.h" -o "$tmp/discard" -H 'accept-encoding: gzip' "$base$entry"
[ "$(header content-encoding "$tmp/entry.h")" = 'gzip' ] || fail "$entry not gzip"
# Only a precompressed file (gzip_static) has a Content-Length; on-the-fly gzip is chunked.
[ -n "$(header content-length "$tmp/entry.h")" ] || fail "$entry was compressed on the fly, not precompressed"
header cache-control "$tmp/entry.h" | grep -q immutable || fail "$entry not immutable"
ok 'assets: precompressed gzip, immutable'

code=$(curl -s -o "$tmp/discard" -w '%{http_code}' "$base/assets/does-not-exist.js")
[ "$code" = 404 ] || fail "missing asset returned $code, not 404"
ok 'missing asset: 404'

mjs=$(docker compose exec -T web find /usr/share/nginx/html/vendor -name maplibre-gl.mjs)
curl -fsSI "$base${mjs#/usr/share/nginx/html}" | grep -qi '^content-type: text/javascript' ||
  fail 'MapLibre module not served as JavaScript (nosniff would block it)'
[ -z "$(docker compose exec -T web find /usr/share/nginx/html -name '*.map')" ] || fail 'source maps shipped'
ok 'MapLibre .mjs: text/javascript; no source maps'

# --- API through nginx --------------------------------------------------------------------------
curl -fsS -D "$tmp/dataset.h" -o "$tmp/dataset.json" "$base/api/v1/dataset"
grep -q '"satellites"' "$tmp/dataset.json" || fail '/dataset'
# The API sets its own headers (helmet); nginx must not add the static site's CSP to them.
! grep -qi '^content-security-policy:.*openfreemap' "$tmp/dataset.h" || fail 'static-site CSP leaked onto API responses'
ok '/dataset: data, API headers untouched'

curl -fsS -D "$tmp/tracks.h" -o "$tmp/tracks.br" -H 'accept-encoding: br' "$base/api/v1/tracks/binary"
[ "$(header content-encoding "$tmp/tracks.h")" = 'br' ] || fail 'tracks not brotli'
size=$(wc -c <"$tmp/tracks.br")
[ "$size" -le "$tracks_budget_bytes" ] || fail "tracks $size B over the 600 KB budget"
etag=$(header etag "$tmp/tracks.h")
code=$(curl -s -o "$tmp/discard" -w '%{http_code}' -H 'accept-encoding: br' -H "if-none-match: $etag" "$base/api/v1/tracks/binary")
[ "$code" = 304 ] || fail "tracks revalidation returned $code, not 304"
ok "/tracks/binary: brotli, $size B, 304 on revalidation"

# The brief's inspiration example: 46 passes over the UAE in the week at 400 km.
curl -fsS "$base/api/v1/accesses?lat=24.454&lon=54.377&radiusKm=400" | grep -q '"passCount":46' || fail '/accesses'
ok '/accesses: the UAE example'

# --- Container hardening ------------------------------------------------------------------------
[ "$(docker compose exec -T web id -u)" = 101 ] || fail 'web must run as uid 101'
for service in api web; do
  id=$(docker compose ps -q "$service")
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$id")" = true ] || fail "$service root filesystem is writable"
done
[ "$(docker inspect -f '{{.Config.User}}' "$(docker compose ps -q api)")" = '65532:65532' ] || fail 'api must run as 65532'
ok 'containers: non-root, read-only root filesystems'

echo '✅ Docker smoke test passed'
