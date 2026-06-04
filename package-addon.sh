#!/usr/bin/env bash
# Build a Thunderbird installable .xpi (ZIP with manifest.json at archive root).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(grep -m1 '"version"' manifest.json | sed 's/.*"\([^"]*\)".*/\1/')
OUT="Email-Archive-Assistant-${VERSION}.xpi"
rm -f "$OUT"
zip -r "$OUT" manifest.json background pages icons
echo "Created $OUT — use Add-ons Manager → gear → Install Add-on From File"
