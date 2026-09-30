#!/bin/sh
# Build sp-stream-downloader.xpi (Firefox / Zen) from the working tree:
# only the extension's own files, with manifest.json at the root of the zip.
set -eu
cd "$(dirname "$0")"
OUT=sp-stream-downloader.xpi
rm -f "$OUT"
zip -q "$OUT" manifest.json *.js *.css *.html
echo "$OUT prêt ($(unzip -l "$OUT" | tail -1 | awk '{print $2}') fichiers)"
