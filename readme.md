# Email Archive Assistant

Thunderbird WebExtension that helps archive inbox mail into your archive folders using **local AI** ([Ollama](https://ollama.com)) on your machine—no cloud.

The add-on **indexes** sample messages from folders you select (embeddings + folder paths), then **matches** new inbox mail to those folders by similarity (RAG). You review suggestions on the **Archive** tab or pick a folder while reading mail; each move can **update the index** so the system learns from your choices.

**Requires Thunderbird 128+** (Manifest V3). Current package version: see `manifest.json` (e.g. **1.7.2**).

## Quick start

1. **Install Ollama** and pull models:
   ```bash
   ollama pull qwen2.5:3b-instruct
   ollama pull nomic-embed-text
   ```
2. **Start Ollama with CORS** (required for Thunderbird; otherwise NetworkError / 403):
   ```bash
   OLLAMA_ORIGINS="moz-extension://*" ollama serve
   ```
   Or: `./scripts/ollama-serve-thunderbird.sh`  
   On Linux with the `ollama` systemd service: `sudo systemctl edit ollama` and add  
   `Environment="OLLAMA_ORIGINS=moz-extension://*"`, then `sudo systemctl daemon-reload && sudo systemctl restart ollama`.
3. **Install the add-on** (see [Installing the add-on](#installing-the-add-on) below).
4. **Open the assistant**
   - Click the **add-on toolbar icon** → **Open assistant**, or  
   - **Add-ons and Themes** → **Email Archive Assistant** → **Preferences** → **Open assistant**, or  
   - **≡ (app menu) → Tools** → **Open Email Archive Assistant** (if listed), or  
   - Shortcut **Alt+Shift+A**
5. **Training tab:** choose account, select archive folders, set Ollama URL/models if needed, **Test connection**, then **build the index**.
6. **Archive tab:** classify inbox messages (RAG), adjust confidence threshold, **Archive confident** to move in bulk.
7. **While reading mail:** use **Archive to folder** on the message toolbar (searchable popup, best match first with **%** scores). In **Inbox**, right-click → **Archive to folder** for a ranked submenu (top 25) or **Filter folders…** for the full list.

Default Ollama URL: `http://127.0.0.1:11434` (change on the Training tab). For a custom host, approve the permission prompt when **Test connection** asks for it.

If `curl http://127.0.0.1:11434/api/tags` works but Thunderbird does not, it is usually **Ollama CORS**. Restart Ollama with `OLLAMA_ORIGINS="moz-extension://*"` as above.

**After changing the embedding model**, rebuild the index on the Training tab. Old embeddings will not rank correctly with a new model.

## Features

| Area | What it does |
|------|----------------|
| **Training** | Per-account folder tree; index up to *N* samples per folder (configurable, default 10); optional global cap on total indexed messages; stores embeddings in Thunderbird `storage.local`. |
| **Archive** | Lists inbox messages; classifies with **RAG only** (one embed per message, no per-message chat call); confidence threshold; bulk move. |
| **Archive to folder** | Message toolbar popup: filter folders, list sorted by **match %**, preselect best match, Enter to move; learns from your pick. |
| **Inbox context menu** | **Archive to folder** submenu (ranked, up to 25 folders) + **Filter folders…** for the popup when you have many folders. |
| **Toolbar / shortcuts** | Icon popup: open assistant or settings; **Alt+Shift+A** opens the assistant. |

Classification and folder ranking use **cosine similarity** between the current message embedding and indexed samples—not a separate “black box” pick in the menu or archive batch flow.

## Installing the add-on

Thunderbird cannot install a bare `manifest.json`. Use a packaged **`.xpi`** or a temporary load for development.

**Permanent install**

1. Build locally: `./package-addon.sh` → `Email-Archive-Assistant-<version>.xpi`  
   Or download the latest `.xpi` from **Actions → Build add-on → Artifacts** (`email-archive-assistant-xpi`), or from a **Release** when you push a tag like `v1.7.2`.
2. **Add-ons and Themes** → gear → **Install Add-on From File…**
3. Select the `.xpi` file.

After upgrades, reload or reinstall the add-on if behavior seems stale. Remove an old version first if you hit odd menu or permission issues.

**Development (reload after each change)**

1. `about:debugging` → **This Thunderbird** → **Load Temporary Add-on…**
2. Choose `manifest.json` from this project.

## Project layout

```
manifest.json
background/          # background scripts (menus, index, Ollama, moves)
pages/               # assistant UI, training, archive, folder picker, options
icons/
package-addon.sh     # build .xpi
scripts/             # e.g. ollama-serve-thunderbird.sh
```

## Requirements (design)

- Fully integrated Thunderbird WebExtension (accounts, folders, messages, storage).
- Mail stays on the server (IMAP sync is Thunderbird’s normal behavior).
- No cloud APIs; Ollama runs locally.

## Training (behavior)

- Lists email accounts and folders; system folders (Inbox, Sent, Drafts, Trash, Junk, etc.) are excluded from the default selection.
- User selects folders and starts indexing; selection is saved per account.
- Index is stored per account (`index_<accountId>`); can be deleted and rebuilt from the Training tab.
- Settings: chat model (reserved for future/optional flows), **embedding model** (required for index and ranking), samples per folder, optional total message cap.

## Archive (behavior)

- Choose an account that has an index.
- Set a **confidence threshold** (%); messages at or above it qualify for **Archive confident**.
- Classify inbox (batched); edit target folder in the table if needed; move selected or confident messages to the predicted folder.

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Ollama connection fails | `ollama serve` with `OLLAMA_ORIGINS`; **Test connection** on Training; Flatpak/snap may need the same URL as in Training. |
| Folder list alphabetical, no **%** | Ollama off, index missing, or **embed model changed** without rebuild; read the status line in the folder picker. |
| **Archive to folder** button missing | Message toolbar **⋯ Customize** → add **Archive to folder**. |
| Preferences greyed out | Old add-on without `options_ui`; install a current `.xpi`. |
| No Tools menu entries | Use toolbar icon or **Alt+Shift+A**; extension items appear under **≡ → Tools** when registered. |

## Development background

The project was built as an exercise: application code written with AI assistance, using Thunderbird WebExtension APIs documented via a local scrape (`utils/ThunderbirdDocScraper.py` → `_Docs/thunderbird_docs`).

Tools used include Cursor, Windsurf, Claude, and ChatGPT o1 for planning. See `_Docs/DevelopmentPlan.md`, `_Docs/CursorPrompts.md`, and `.cursor/rules/` for history and conventions.

### Initial specifications (summary)

Two parts: (1) train on user archive folders—message content as features, folder path as label; (2) archive inbox messages with predicted folder and user-confirmed moves. Full original spec text remains in the git history of this file and in `_Docs/DevelopmentPlan.md`.
