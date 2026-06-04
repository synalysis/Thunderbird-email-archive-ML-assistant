#!/usr/bin/env bash
# Start Ollama so Thunderbird WebExtensions can call the API (CORS).
export OLLAMA_ORIGINS="${OLLAMA_ORIGINS:-moz-extension://*,chrome-extension://*,safari-web-extension://*}"
exec ollama serve
