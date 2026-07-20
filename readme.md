# Email Archive Assistant

Thunderbird WebExtension that helps archive inbox mail into your archive folders using **local AI** ([llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`) on your machine—no cloud.

The add-on **indexes** sample messages from folders you select (embeddings + folder paths), then **matches** new inbox mail to those folders by similarity (RAG). You review suggestions on the **Archive** tab or pick a folder while reading mail; each move can **update the index** so the system learns from your choices.

**Requires Thunderbird 128+** (Manifest V3). Current package version: see `manifest.json` (e.g. **1.8.0**).

## Quick start

1. **Build or obtain a GGUF embedding model** (e.g. `nomic-embed-text`, `bge-small-en-v1.5`).
2. **Start the embedding server** on port **8083**:
   ```bash
   llama-server -m /path/to/embed-model.gguf --embedding --pooling cls --port 8083 --host 127.0.0.1
   ```
   Or: `./scripts/llama-server-embed.sh /path/to/embed-model.gguf`
3. **Install the add-on** (see [Installing the add-on](#installing-the-add-on) below).
4. **Open the assistant**
   - Click the **add-on toolbar icon** → **Open assistant**, or  
   - **Add-ons and Themes** → **Email Archive Assistant** → **Preferences** → **Open assistant**, or  
   - **≡ (app menu) → Tools** → **Open Email Archive Assistant** (if listed), or  
   - Shortcut **Alt+Shift+A**
5. **Training tab:** set **Embedding API URL** to `http://127.0.0.1:8083`, **Test connection**, pick **bge-m3** (or your embed model), then **build the index**.
6. **Archive tab:** classify inbox messages (RAG), adjust confidence threshold, **Archive confident** to move in bulk.
7. **While reading mail:** use **Archive to folder** on the message toolbar (searchable popup, best match first with **%** scores). In **Inbox**, right-click → **Archive to folder** for a ranked submenu (top 25) or **Filter folders…** for the full list.

Default embedding URL: `http://127.0.0.1:8083`. Approve the host permission prompt when **Test connection** asks.

Verify: `curl http://127.0.0.1:8083/health` and a POST to `/v1/embeddings`.

**After changing the embedding model or server**, rebuild the index on the Training tab. Old embeddings will not rank correctly with a new model.

## llama.cpp vs Ollama

This add-on uses **llama.cpp** (`llama-server`) instead of Ollama for faster local inference. Old Ollama settings are migrated automatically to the embedding server URL.

## Features

| Area | What it does |
|------|----------------|
| **Training** | Per-account folder tree; **Build index for all accounts**; index up to *N* samples per folder (configurable, default 10); optional global cap on total indexed messages; stores embeddings in Thunderbird `storage.local`. |
| **Archive** | Lists inbox messages for one account or **all indexed accounts**; classifies with **RAG only** (one embed per message); confidence threshold; bulk move. |
| **Archive to folder** | Message toolbar popup: filter folders, list sorted by **match %**, preselect best match, Enter to move; learns from your pick. |
| **Inbox context menu** | **Archive to folder** submenu (ranked, up to 25 folders) + **Filter folders…** for the popup when you have many folders. |
| **Toolbar / shortcuts** | Icon popup: open assistant or settings; **Alt+Shift+A** opens the assistant. |

Classification and folder ranking use **cosine similarity** between the current message embedding and indexed samples.

## Installing the add-on

Thunderbird cannot install a bare `manifest.json`. Use a packaged **`.xpi`** or a temporary load for development.

**Permanent install**

1. Build locally: `./package-addon.sh` → `dist/Email-Archive-Assistant-<version>.xpi`  
   Or download the latest `.xpi` from **Actions → Build add-on → Artifacts** (`email-archive-assistant-xpi`), or from a **Release** when you push a tag like `v1.8.0`.
2. **Add-ons and Themes** → gear → **Install Add-on From File…**
3. Select the `.xpi` file.

After upgrades, reload or reinstall the add-on if behavior seems stale.

**Development (reload after each change)**

1. `about:debugging` → **This Thunderbird** → **Load Temporary Add-on…**
2. Choose `manifest.json` from this project.

## Project layout

```
manifest.json
background/          # background scripts (menus, index, llama.cpp client, moves)
pages/               # assistant UI, training, archive, folder picker, options
icons/
package-addon.sh     # build .xpi into dist/
scripts/             # e.g. llama-server-embed.sh
```

## Requirements (design)

- Fully integrated Thunderbird WebExtension (accounts, folders, messages, storage).
- Mail stays on the server (IMAP sync is Thunderbird’s normal behavior).
- No cloud APIs; llama.cpp runs locally.

## Training (behavior)

- Lists email accounts and folders; system folders (Inbox, Sent, Drafts, Trash, Junk, etc.) are excluded from the default selection.
- User selects folders per account, or uses **Build index for all accounts** to index every Thunderbird account (using each account’s saved folder selection).
- Index is stored per account (`index_<accountId>`); can be deleted and rebuilt from the Training tab.
- Settings: embedding model name (as reported by `/v1/models` or `default`), samples per folder, optional total message cap.

## Archive (behavior)

- Choose one indexed account or **All indexed accounts** to load and classify every inbox in one table (Account column shows the source).
- Set a **confidence threshold** (%); messages at or above it qualify for **Archive confident**.
- Classify inbox (batched); edit target folder in the table if needed; move selected or confident messages to the predicted folder.

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Connection fails | `llama-server` running with `--embedding --port 8083`; **Test connection** on Training; approve host permission. |
| Folder list alphabetical, no **%** | Server off, index missing, or **embed model changed** without rebuild; read the folder picker status line. |
| **Archive to folder** button missing | Message toolbar **⋯ Customize** → add **Archive to folder**. |
| Preferences greyed out | Install a current `.xpi` with `options_ui`. |
| No Tools menu entries | Use toolbar icon or **Alt+Shift+A**. |

## Development background

The project was built as an exercise: application code written with AI assistance, using Thunderbird WebExtension APIs documented via a local scrape (`utils/ThunderbirdDocScraper.py` → `_Docs/thunderbird_docs`).

Tools used include Cursor, Windsurf, Claude, and ChatGPT o1 for planning. See `_Docs/DevelopmentPlan.md`, `_Docs/CursorPrompts.md`, and `.cursor/rules/` for history and conventions.
