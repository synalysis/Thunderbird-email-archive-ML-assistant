#!/usr/bin/env bash
# Example: start llama.cpp embedding server for Thunderbird Email Archive Assistant.
# Requires a GGUF embedding model (e.g. nomic-embed-text, bge-m3).
#
# The add-on caps each embed request to ~512 tokens (From + Subject + body preview).
# Default llama-server batch size (512) is sufficient.
#
# Usage:
#   ./scripts/llama-server-embed.sh /path/to/embed-model.gguf
#
set -euo pipefail
MODEL="${1:-}"
if [[ -z "$MODEL" ]]; then
  echo "Usage: $0 /path/to/embedding-model.gguf" >&2
  exit 1
fi
exec llama-server \
  -m "$MODEL" \
  --embedding \
  --pooling cls \
  --port 8083 \
  --host 127.0.0.1
