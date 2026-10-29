# API Reference

> REST API reference for VEIL.

Base URL: `http://localhost:7860`

The API is intentionally local-first and single-user oriented. Responses are JSON unless an endpoint explicitly returns media bytes.

`site/api/openapi.json` is the machine-readable public contract rendered by the Scalar portal. It contains every supported non-legacy `/api/*` route. This document is the detailed human reference with behavior, examples, and compatibility notes. Public Flask routes and OpenAPI are kept synchronized by `tests/test_openapi_contract.py`.

The old workflow editor and its `/api/editor/*` endpoints were removed on 2026-10-14. `/editor/legacy`, `/settings/comfyui`, and `/api/ai/remix` are unavailable. Viewer Remix opens `/create?photo=<asset_id>&mode=variation`, attaches the original image, and waits for the user to start Create.

---

## Table of Contents

- [Folders](#folders)
- [Scanning and Uploads](#scanning-and-uploads)
- [Viewer media list](#viewer-media-list)
- [Library and Albums](#library-and-albums)
- [Thumbnails and Originals](#thumbnails-and-originals)
- [Cutouts](#cutouts)
- [AI Providers](#ai-providers)
- [AI Prompt Drafts](#ai-prompt-drafts)
- [AI Prompt Operations](#ai-prompt-operations)
- [ComfyUI Runtime](#comfyui-runtime)
- [Remote GPU (Google Colab)](#remote-gpu-google-colab)
- [Create (Simple) API](#create-simple-api)
- [Social API](#social-api)
- [System](#system)
- [Data Models](#data-models)

---

## Folders

### `GET /api/folders`

Returns all indexed folders, including the special `Uploads` folder when uploaded images exist.

**Response:**

```json
{
  "folders": [
    {
      "id": 1,
      "path": "/path/to/images",
      "name": "images",
      "scanned_at": "2026-06-17 12:00:00",
      "created_at": "2026-06-17 12:00:00",
      "image_count": 42,
      "asset_count": 45,
      "video_count": 3,
      "enabled": true,
      "recursive": true,
      "source_status": "available",
      "last_error": null,
      "revision": 4
    }
  ]
}
```

---

### `PATCH /api/folders/{folder_id}`

Updates a physical source. Every field is optional, but at least one must be present.
Disabling a source stops observation and hides its images without deleting indexed rows.
Enabling it queues a reconciliation.

```json
{ "enabled": true, "recursive": true, "name": "ComfyUI Output" }
```

`source_status` is one of `disabled`, `available`, `partially_available`, `unavailable`,
`reconnecting`, or `error`.

---

### `POST /api/folders/{folder_id}/reconcile`

Queues an immediate full reconciliation for an enabled source.

```json
{ "ok": true }
```

---

### `DELETE /api/folders/{folder_id}`

Forgets a source, stops its watcher, and deletes its indexed rows. Source files are untouched.

**Response:**

```json
{ "ok": true }
```

---

### `GET /api/folders/events`

Server-Sent Events stream of the live folder state instead of one-off JSON snapshots. Each event
carries a JSON object keyed by folder ID and is emitted whenever any folder state changes. While a
folder is processing or reconnecting, events are pushed every second; otherwise every five seconds.

```json
data: {"1": {"status": "processing", "source_status": "available", "enabled": true, "image_count": 42}}
```

### `POST /api/folders/{folder_id}/pause`

Temporarily pauses observation and reconciliation for one source. The watch is stopped, and the
source can be resumed later without re-adding it.

**Response:** `{ "ok": true }`

### `POST /api/folders/{folder_id}/resume`

Resumes the paused source and restarts the background worker.

**Response:** `{ "ok": true }`

---

## Scanning and Uploads

### `POST /api/scan`

Connects and scans a local folder in-place. Existing rows are reused when file size and `mtime` did not change. The saved source is then maintained automatically by filesystem events and periodic reconciliation.

**Request:**

```json
{ "path": "/path/to/folder" }
```

**Response:**

```json
{
  "folder_id": 1,
  "folder": {
    "id": 1,
    "path": "/path/to/folder",
    "name": "folder",
    "scanned_at": "2026-06-17 12:00:00",
    "created_at": "2026-06-17 12:00:00",
    "image_count": 42
  },
  "page": 1,
  "per_page": 50,
  "total": 42,
  "images": [
    {
      "id": 1,
      "file_name": "image.png",
      "format": "PNG",
      "size": [1024, 768],
      "mode": "RGBA",
      "error": null,
      "thumbnail": null,
      "file": null,
      "path": null,
      "has_local_file": true
    }
  ],
  "cached": 40,
  "processed": 2
}
```

**Behavior:**

- Scans files in the selected folder, optionally including subfolders.
- Expands and normalizes the folder to an absolute path before saving it.
- Supports `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tiff`, and `.tif` when supported by the parser.
- Skips unchanged files using stored size and `mtime` values.
- Stores metadata in SQLite.
- Returns the first paginated page of indexed images.
- Debounces event bursts and waits for size/mtime stability before processing copied files.
- Treats a temporarily unavailable root as offline rather than deleting its indexed rows.

---

### `POST /api/choose-folder`

Opens the local operating system's folder dialog. A successful selection returns an
absolute native path; cancellation returns `null`.

```json
{ "path": "/path/to/folder", "name": "My source", "recursive": true }
```

If a graphical picker is unavailable, the endpoint returns HTTP `503` and the web client
falls back to a manual path prompt:

```json
{
  "error": "Tk folder picker is not installed",
  "code": "folder_picker_unavailable",
  "fallback": "Enter the folder path manually"
}
```

---

### `POST /api/extract`

Extracts metadata from explicit local file paths without indexing them into the SQLite library.

**Request:**

```json
{
  "paths": [
    "/path/to/image1.png",
    "/path/to/image2.png"
  ]
}
```

**Response:**

```json
{
  "images": [
    {
      "file": "image1.png",
      "path": "/path/to/image1.png",
      "format": "PNG",
      "size": [1024, 768],
      "mode": "RGBA",
      "error": null,
      "exif": {},
      "prompt_parameters": {},
      "workflow": {},
      "prompt_api_json": {},
      "workflow_ui_json": {},
      "raw_parameters": null,
      "thumbnail": "data:image/jpeg;base64,..."
    }
  ],
  "count": 1
}
```

---

### `POST /api/upload`

Uploads image or video files through `multipart/form-data`. Uploaded originals are stored as SQLite BLOBs. Images use a lightweight format-aware probe for PNG text keys and JPEG/WebP EXIF, XMP, or comment blocks, then defer full extraction until `GET /api/images/{image_id}` is called. Videos are stored in `Uploads`; ffprobe extracts technical metadata and ffmpeg creates a cached JPEG poster during import. Missing FFmpeg tools leave the original available with an `unavailable` metadata or preview status.

**Request:** `multipart/form-data` with one or more `files` fields.

**Response:**

```json
{
  "assets": [
    {
      "id": 1,
      "folder_id": 1,
      "file_name": "uploaded.mp4",
      "file_size": 123456,
      "media_type": "video",
      "preview_status": "ready"
    }
  ],
  "images": [
    {
      "id": 1,
      "folder_id": 1,
      "file_name": "uploaded.mp4",
      "file_size": 123456,
      "media_type": "video",
      "preview_status": "ready"
    }
  ],
  "count": 1,
  "folder_id": 1
}
```

---

## Viewer media list

### `GET /api/images`

Returns a paginated folder, album, or global media list. The route remains named `/api/images`
for compatibility and defaults to images only. Pass `media_type=image,video` for a unified
list or `media_type=video` for videos only. Assets from disabled sources are omitted;
`folder_id` and `album_id` are mutually exclusive.

The Viewer always supplies its persisted image/video checkbox selection through this
parameter for both the global Media sidebar and the central folder or album gallery.

**Query Parameters:**

| Parameter | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `folder_id` | int | -- | no | Folder ID to load |
| `album_id` | int | -- | no | Virtual album ID to load |
| `page` | int | `1` | no | Page number |
| `per_page` | int | `50` | no | Assets per page |
| `sort_by` | string | `date` | no | `name`, `date`, `size`, `type`, or `custom` (server-side drag order; `sort_dir` is ignored for it) |
| `sort_dir` | string | `desc` | no | `asc` or `desc` |
| `rating` | int | -- | no | Exact rating from `0` (unrated) through `5` |
| `media_type` | string | `image` | no | Comma-separated `image`, `video`, or both |

**Response:**

```json
{
  "images": [
    {
      "id": 1,
      "file_name": "image.png",
      "media_type": "image",
      "format": "PNG",
      "size": [1024, 768],
      "mode": null,
      "error": null,
      "thumbnail": null,
      "file": null,
      "path": null,
      "rating": 4
    }
  ],
  "total": 200,
  "page": 1,
  "per_page": 50
}
```

---

### `GET /api/images/{image_id}`

Returns full metadata for a single image. If an uploaded image has not been opened before, this request extracts its metadata from the stored original and caches the resulting JSON in SQLite. Other uploaded images remain unprocessed.

**Response:**

```json
{
  "id": 1,
  "file_name": "image.png",
  "format": "PNG",
  "size": [1024, 768],
  "mode": "RGBA",
  "error": null,
  "thumbnail": null,
  "file": null,
  "path": null,
  "has_local_file": true,
  "prompt_parameters": {
    "positive_prompt": "a beautiful landscape",
    "negative_prompt": "blurry",
    "generation_settings": {
      "Steps": 20,
      "Sampler": "euler",
      "CFG scale": 7.0,
      "Seed": 12345
    }
  },
  "workflow": {},
  "exif": {},
  "raw_chunks": null,
  "raw_parameters": null,
  "raw_params": null,
  "folder_id": null
}
```

---

### `DELETE /api/images/{image_id}`

Deletes an image row, its virtual library relations, and related thumbnail/preview/cutout
cache files. The physical source file is not deleted.

**Response:**

```json
{ "ok": true }
```

---

### `GET /api/images/{image_id}/file-location`

Returns the resolved physical path for a scanned local image. Uploaded originals stored
inside the app return `409 no_local_file`; missing physical sources return
`404 local_file_unavailable`.

```json
{ "path": "C:\\images\\image.png" }
```

### `POST /api/images/{image_id}/reveal`

Opens the operating system's file manager for a scanned local image. Windows Explorer
and macOS Finder select the file; Linux opens the containing directory through
`xdg-open`.

```json
{ "ok": true }
```

---

## Library and Albums

The separate `/library` page uses these endpoints for virtual organization. Library reads
include disabled and temporarily unavailable sources so album membership, favorites, tags,
notes, and ratings remain visible while a drive or cloud mirror is offline.

### `GET /api/library`

Returns system collection definitions, summary counts, and the current album list.

### `GET /api/library/assets`

Returns paginated library cards. Supported query parameters are `collection`, `album_id`,
`page`, `per_page`, `sort_by`, `sort_dir`, `q`, `source_id`, and `tag`. `collection` is one
of `all`, `favorites`, `without_metadata`, `recently_added`, `unavailable`, `images`,
`videos`, `not_rated`, or `album`. `sort_by=custom` serves the server-side drag order
(see Custom order below); `sort_dir` is ignored for it.

Each asset includes source/availability fields, `has_local_file`, favorite/rating/note/tags,
all album IDs, thumbnail/original URLs, `media_type`, MIME type, video technical fields, and
`preview_status` / `preview_error`.

### `GET /api/assets/{asset_id}`

Returns details for either an image or video. `/api/images/{image_id}` remains as a compatible
alias. The response exposes three distinct metadata layers:

- `embedded_metadata`: data extracted from the original file;
- `user_metadata`: favorites, rating, note, and tags;
- `ai_annotations`: derived AI results, never presented as embedded generator metadata.

Video details additionally include `duration`, `frame_rate`, `codec`, `mime_type`, and preview state.

### `PATCH /api/library/assets/{asset_id}`

Updates any combination of virtual per-asset fields:

```json
{
  "favorite": true,
  "rating": 4,
  "note": "Primary launch direction",
  "tags": ["hero", "approved"]
}
```

`images` remains a compatibility alias for `assets` in this response.

A rating of `0` clears the rating.

### `POST /api/library/assets/bulk`

Applies a mass action to as many as 1,000 selected assets. Actions are `favorite`,
`unfavorite`, `add_to_album`, `remove_from_album`, `set_rating`, and `remove_from_index`.
Album actions require `album_id`; rating requires `rating`.

```json
{
  "asset_ids": [12, 13, 14],
  "action": "add_to_album",
  "album_id": 3
}
```

`remove_from_album` changes only the join table. `remove_from_index` deletes database rows,
virtual relations, and generated caches. Neither action deletes physical source files.
An indexed file that remains inside an enabled monitored source can be discovered again by
a later reconciliation.

### `POST /api/library/assets/trash`

Accepts up to 1,000 indexed assets and returns instantly: one atomic commit
removes the index rows, records a tombstone per asset, and enqueues a
`trash_assets` background job. The slow work — moving physical files to the
operating system's Recycle Bin or Trash and purging generated caches — runs
in the job worker within seconds. Reconciliation skips tombstoned paths, so
trashed files are never resurrected before the worker reaches them; a missing
file is treated as already-gone (success), not an error. Uploaded originals
stored inside the app have no local file and only clear their rows and caches.
A mixed request can therefore return both `removed_ids` and per-asset `failures`
(unknown ids are reported with code `image_not_found`).

```json
{
  "asset_ids": [12, 13, 14]
}
```

This endpoint does not require a confirmation token. Recovery is handled by the operating
system's Recycle Bin or Trash.

### Album endpoints

| Method and path | Behavior |
|-----------------|----------|
| `GET /api/albums` | List albums with asset counts and resolved cover IDs |
| `POST /api/albums` | Create an album from `{ "name": "..." }` |
| `PATCH /api/albums/{album_id}` | Rename it or set/clear a member asset as its cover |
| `DELETE /api/albums/{album_id}` | Delete only the virtual album |
| `POST /api/albums/{album_id}/assets` | Add `asset_ids` without copying files |
| `DELETE /api/albums/{album_id}/assets` | Remove `asset_ids` from the album only |
| `POST /api/albums/{album_id}/reorder` | Persist a custom manual order from `{ "asset_ids": [...] }` |

### Custom order

Drag-and-drop positions for folder and collection views persist server-side in the
`item_positions` table, one scope per view: `folder:<id>`, `media:all`, or
`collection:<id>`. Albums keep their own `album_images.position` mechanism and never
use these scopes.

- Positions are fractional: one drag writes a single row with the midpoint between
  the visible neighbors, so paginated views never need a full rewrite. Scopes
  rebalance themselves on float exhaustion.
- Images without a row are "new" and sort first, newest first — new arrivals land
  on top with no client bookkeeping.
- Deleting an image cascades its rows; moving images between folders (metadata
  split, source consolidation) or deleting a folder prunes the affected
  folder scopes. Collection and `media:all` scopes are membership-based and survive
  folder moves.

| Method and path | Behavior |
|-----------------|----------|
| `GET /api/custom-order?scope=...` | Inspect a scope: positioned ids in view order plus positioned/unpositioned counts |
| `PUT /api/custom-order` | Bulk-replace a scope from `{ "scope": ..., "ordered_ids": [...] }`; ids outside the scope are dropped and reported |
| `POST /api/custom-order/move` | Persist one drag from `{ "scope": ..., "image_id": ..., "before_id": ..., "after_id": ... }` (`before_id`/`after_id` are the visible neighbors, `null` at a view edge) |

---

## Thumbnails and Originals

### `GET /api/thumbnail/{asset_id}`

Returns a JPEG thumbnail. Images use Pillow; videos use `ffmpeg`. If FFmpeg is unavailable,
video requests return `503` with `code: video_preview_tool_unavailable` while image requests
and indexing continue normally.

**Response:** `image/jpeg`

---

### `GET /api/preview/{image_id}`

Returns a display-oriented image whose longest side is at most 4096 pixels. The preview is generated lazily, cached under `cache/previews/`, and does not trigger metadata extraction. JPEG is used for opaque images and WebP for images with transparency. Only one large preview is generated at a time; concurrent uncached requests receive `202` with `Retry-After`.

---

### `GET /api/original/{asset_id}`

Returns the untouched original image or video for inline viewing or download. Uploaded SQLite BLOBs are streamed in chunks; scanned files use a conditional file response with range support instead of being copied fully into Python memory.

**Response:** the indexed MIME type, including supported `image/*` and `video/*` values, or `application/octet-stream`.

---

## Cutouts

### `GET /api/cutout/{image_id}`

Returns an existing transparent PNG cutout. If no cutout exists, the endpoint returns `404`.

**Response:** `image/png`

**Error:**

```json
{ "error": "Cutout not found" }
```

---

### `POST /api/cutout/{image_id}`

Generates a transparent PNG cutout or returns the cached result metadata when it already exists.

**Response:**

```json
{
  "ok": true,
  "image_id": 1,
  "cutout_url": "/api/cutout/1",
  "cached": false
}
```

---

### `DELETE /api/cutout/{image_id}`

Deletes the cached cutout file for an image.

**Response:**

```json
{
  "ok": true,
  "deleted": true
}
```

---

## AI Providers

The management UI is available at `GET /settings/ai`. Provider APIs never return API key
values. A `has_credentials` flag reports only whether the selected system entry or environment
variable is currently available.

Integrations has two AI tabs modelled on OpenCode desktop's settings. **Providers** connects
local AI tools (OpenCode, Claude Code, Codex, Antigravity: installed tools are connected unless the
user disconnects them; nothing is run to list them) and API providers reached through an
OpenAI-compatible endpoint. Provider templates come from models.dev, the catalog OpenCode uses
(`app/ai/assets/provider_catalog.json`, rebuilt by `scripts/update_provider_catalog.py`). **Models**
chooses which models of the connected providers the pickers in Create and the Viewer show, and the
default model used wherever no model is picked. There are no AI profiles; a model is addressed by
`{"host", "model", "variant"}` where `host` is a local tool or `api:<provider id>`.

### `GET /api/ai/providers`

```json
{
  "providers": [
    {
      "id": "openrouter", "template": "openrouter", "name": "OpenRouter",
      "base_url": "https://openrouter.ai/api/v1", "api_key_source": "system", "api_key_env": null,
      "models": [], "has_credentials": true
    }
  ],
  "local_tools": [
    { "type": "opencode", "label": "OpenCode", "icon": "opencode", "installed": true, "connected": true,
      "executable": "C:\\…\\opencode-cli.exe", "note": "Free models right after install, no account or key" }
  ],
  "templates": [ { "id": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1",
                   "env": ["OPENAI_API_KEY"], "doc": "…", "note": "…", "popular": 1, "local": false, "models": 53 } ],
  "default_model": { "host": "opencode", "model": "opencode/exo-free", "variant": null },
  "disconnected_tools": [],
  "secret_store": { "available": true, "backend": "keyring.backends.Windows.WinVaultKeyring", "message": "…" }
}
```

### `POST /api/ai/providers`

Connects a template (`{"template": "openrouter", "api_key": "…"}`; the id defaults to the template
id) or a custom OpenAI-compatible provider (`id`, `name`, `base_url`, optional `api_key` and
`models`). With `api_key_source: "system"` the key goes straight to the OS keyring; `environment`
saves only `api_key_env`; `none` suits local servers such as LM Studio or Ollama. `409`
`provider_exists` or `missing_credentials`.

### `PATCH /api/ai/providers/{provider_id}` · `DELETE /api/ai/providers/{provider_id}`

PATCH updates the name, address, key source or manual models; an empty `api_key` keeps the stored
key. DELETE removes the provider, its keyring entry, its model visibility settings and a default
model that used it.

### `POST /api/ai/providers/{provider_id}/check`

Lists the provider's models (`GET {base_url}/models`) to prove the address and key without an
inference prompt: `{"ok": true, "models": 42}`, or `422` with the provider's error.

### `PATCH /api/ai/local-tools/{tool}`

`{"connected": false}` hides an installed tool and its models from every picker; `true` restores it.

### `GET /api/ai/models`

Groups per provider (OpenCode lists one group per OpenCode provider) with model cards: `vision`
(`true`/`false`, or `null` for an API model without a models.dev card), `free` (OpenCode Zen/Go,
or an explicit `:free` model id), `variants` or Antigravity `levels`, `visible` and
`default_visible`. Like OpenCode, the default list keeps the newest model of each family released
in the last six months; OpenCode's own providers and the local tools show every model, media models
(audio or image output) start hidden. Hosts are listed in parallel, each with its own `error`;
catalogs are cached for 10 minutes and `?refresh=1` refreshes them. `?visible=1` returns only what
pickers show.

### `PATCH /api/ai/models/visibility`

`{"changes": {"opencode|google/gemini-4-argon": true, "claude|sonnet": null}}` shows or hides
models by key (`host|model`); `null` returns a model to its default.

### `GET /api/ai/default-model` · `PUT /api/ai/default-model`

`{"model": {"host": "codex", "model": "gpt-6", "variant": "high"}}` is validated against the
host's catalog (`409` `model_unavailable`); `{"model": null}` lets a free OpenCode model run.

### `GET /api/ai/cli-integrations`

Detects `opencode`, `claude`, `agy`/`antigravity` and `codex` through PATH and invokes documented version
and authorization-status commands. The response includes executable path, version, capability
flags, and an authorization state. No credential file is opened. `?probe=0` skips the live probe and
returns the static catalog instead.

### `GET /api/ai/cli-integrations/{cli_type}`

Probes one integration (`opencode`, `claude`, `antigravity` or `codex`; Providers › Details) and returns its singular `integration`
object. Unsupported CLI types answer with `code: cli_unavailable`. For OpenCode the object also lists
`installations`: every detected npm CLI and OpenCode desktop app (its bundled `opencode-cli`), newest
first, each with `kind` (`cli` / `desktop`), `executable`, `version`, `generation` (1 = classic CLI,
2 = CLI with a background service) and `label`. OpenCode without provider credentials reports
`available`, because the free OpenCode Zen models need no sign-in.

### `GET /api/ai/cli-integrations/{cli_type}/models`

Asks the installed CLI for model IDs when it exposes a model-list command. OpenCode IDs use the
`provider/model` form; `?provider=` narrows the list and `?executable=` picks one of the detected
installations (any other path is rejected). OpenCode responses add `model_info` (per model: `id`,
`provider`, `name`, `vision`, `free`; `null` when unknown) and the installation's `generation`.
Claude Code and Codex return `source: "manual"`; enter an exact model ID
or supported alias (`default` for Codex uses the model from `~/.codex/config.toml`). Antigravity
support is experimental because its documented print mode does not expose a stable JSON response
protocol.

---

## System

### `POST /api/reset-index`

Stops background indexing, waits for application SQLite connections to close, physically
deletes `meta.db`, `meta.db-wal`, `meta.db-shm`, and generated caches, creates a fresh
schema, and queues saved active source directories for reindexing. `/api/reset` is retained
as a compatibility alias. Virtual albums, favorites, ratings, tags, notes, and uploaded
originals stored as SQLite BLOBs are permanently deleted; files in scanned source
directories are not modified.

**Request:**

```json
{ "confirm": "reset-index" }
```

**Response:**

```json
{
  "ok": true,
  "factory_reset": false,
  "deleted": ["/path/to/meta.db", "/path/to/cache/thumbnails/1.jpg"],
  "reindexed_sources": ["/path/to/source"],
  "skipped_sources": []
}
```

Saved sources that are temporarily unavailable remain in `config.json` and are returned in
`skipped_sources`. A file deletion failure returns HTTP `500` with an explicit `failures`
array instead of being ignored.

---

### `POST /api/factory-reset`

Performs Reset Index and additionally deletes `config.json`. The web client also clears its
versioned browser preferences after a successful response. This endpoint requires its own
confirmation token.

```json
{ "confirm": "factory-reset" }
```

---

### `GET /api/diagnostics`

Returns local diagnostics and cache statistics.

**Response:**

```json
{
  "db_path": "/absolute/path/to/project/.mediastudio_data/meta.db",
  "folders": 3,
  "images": 150,
  "uploads": 12,
  "thumbnail_dir": "/absolute/path/to/project/cache/thumbnails",
  "thumbnail_count": 138,
  "preview_dir": "/absolute/path/to/project/cache/previews",
  "preview_count": 7,
  "cutout_dir": "/absolute/path/to/project/cache/cutouts",
  "cutout_count": 5,
  "upload_dir": "/absolute/path/to/project/.mediastudio_data"
}
```

---

## AI Prompt Drafts

`POST /api/ai/adapt` creates a family-aware prompt adaptation. In addition to `source`, `task`,
`target_family`, and the optional tested `checkpoint_profile`, the caller can send
`checkpoint_resource_hash` when the selected checkpoint exists in the local model catalog. Trusted
catalog trigger words that are already present in the source prompt are protected across normalized
execution and recorded in the adaptation as `protected_triggers`; catalog triggers absent from the
source are not injected.

`GET /api/ai/jobs/{job_id}` returns the durable job snapshot, including the current `SceneSpec`,
all prompt draft revisions, the normalized result, and execution metadata.

`GET /api/ai/prompt-drafts/{draft_id}` returns one draft plus its execution context.

`PATCH /api/ai/prompt-drafts/{draft_id}` accepts `positive_prompt` and/or `negative_prompt`.
It creates and returns an append-only manual revision; the original AI output is not overwritten.

`POST /api/ai/jobs/{job_id}/review` promotes the latest draft to the final result. Pass an optional
`draft_id` to accept a specific revision. `POST /api/ai/jobs/{job_id}/cancel` cancels a queued,
running, or review-waiting job.

```json
{
  "positive_prompt": "edited prompt",
  "negative_prompt": "edited negative prompt"
}
```

---

## AI Prompt Operations

The operation endpoints parse the model, task, and source the same way and return a durable
`job`, the latest normalized `prompt_draft`, and a `context` (the full message exchange). Job IDs
can be followed through [AI Prompt Drafts](#ai-prompt-drafts).

### `GET /api/ai/prompt-capabilities`

Returns the compiled capability matrix: for every registered prompt family (`flux`, `sdxl`,
`pony`), the declared version and the scenarios (`portrait`, `single_character`, `product_object`,
`architecture_interior`, `landscape_environment`, `illustration_art`, `graphic_design_text`) with
their tested status (`complete`, `partial`, `planned`).

### `POST /api/ai/generate`

Runs a direct raw `generate` operation. The task dictionary must include a scenario. Every
operation takes an optional `agent` (`{"host", "model", "variant"}`); without it the default model
runs, and `409` `no_ai_model` reports that none is available. Returns `201`.

```json
{
  "agent": { "host": "api:openrouter", "model": "anthropic/claude-sonnet-5" },
  "task": { "family": "flux", "scenario": "portrait" },
  "user_input": "…"
}
```

### `POST /api/ai/translate`

Translates `source` text. `target_language` defaults to `en`; `source_language` is optional. A
reference `asset_id` can be attached for provenance. When `?stream=1`, the `Accept` header requests
`text/event-stream`, or the payload sets `stream: true`, the endpoint streams SSE events
(`status`, `chunk`, `error`/`result`).

### `POST /api/ai/adapt`

Family-aware adaptation. `target_family` and the optional tested `checkpoint_profile` configure the
destination; `checkpoint_resource_hash` resolves the local checkpoint from the model catalog when
present. Trusted catalog trigger words already in the source are preserved as `protected_triggers` -
catalog triggers absent from the source are not injected. Returns `201`.

### `POST /api/ai/enhance`

Enhances a prompt toward stronger composition, lighting, and subject detail. Accepts an optional
`wishes` directive, `checkpoint_profile`, and `checkpoint_resource_hash`. Returns `201`.

### `POST /api/ai/reconstruct`

Renders a full prompt from a saved `SceneSpec`, supplied either directly in `scene_spec` or via a
`scene_spec_job_id` returned by vision analysis. A `scene_spec_job_id` keeps the operation consistent:
if both are given at once, `asset_id` must match the asset attached to the saved `SceneSpec`. Returns
`201` with the job, `scene_spec`, prompt draft, and context.

### `POST /api/ai/reconstruct/analyze`

Runs multimodal vision analysis over an existing asset and returns a `SceneSpec` (the "analyze first"
step). Requires a model that sees photos (`409` `vision_required`); `agent` defaults to the default model. `asset_id` is
required; `task` follows the same shape as other operations. Returns `201`.

### `PATCH /api/ai/jobs/{job_id}/scene-spec`

Replaces the editable `SceneSpec` of a reconstruct job. Only a job in `WAITING_FOR_REVIEW` whose
operation is `reconstruct` accepts edits.

```json
{ "scene_spec": { "…": "valid SceneSpec" } }
```

### `GET /api/ai/resources`

Lists model resources from the catalog, optionally filtered by `resource_type` and `architecture`.

### `POST /api/ai/resources`

Registers a model resource in the catalog. Returns `201` with the saved resource.

### `POST /api/ai/resources/resolve`

Validates a proposed model selection against a checkpoint architecture and returns per-resource
`evaluations` (coverage and compatibility decisions).

### `POST /api/ai/evaluate`

Runs AI ranking for one asset: a model that sees photos (`agent`, else the default model), the target `image_id`, and an
optional `prompt_text`. Returns the derived `rating` (never stored back into generator metadata).

### `GET /api/ai/ratings/{image_id}`

Returns the stored AI rating for an asset, or `404` when none exists.

### `PATCH /api/ai/ratings/{image_id}`

Sets a manual rank override (`rank_override`) on top of the stored AI rating.

### `DELETE /api/ai/ratings/{image_id}`

Deletes the stored AI rating and any manual override for the asset.

```json
{ "ok": true }
```

---

## ComfyUI Runtime

`GET /create` and `GET /editor` open Create. Runtime configuration and controls are available in Create's ComfyUI dialog and through the public `/api/comfyui/*` routes. Create retains durable SQLite drafts/runs and shared output import, error diagnostics, inventory, and local/Colab backends. Removing the old editor does not drop database tables or delete saved user templates.

### Runtime control

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET/POST` | `/api/comfyui/config` | Read or update the ComfyUI Desktop installation, VEIL's own models, input and output folders, host, port, and launch arguments |
| `GET` | `/api/comfyui/installations` | List ComfyUI Desktop installations (last used first) and Desktop's models, input and output folders |
| `POST` | `/api/comfyui/detect` | Validate an installation folder; names its ComfyUI Desktop installation when there is one |
| `GET` | `/api/comfyui/status` | Return managed/external mode, health, queue, installation, and hardware data |
| `POST` | `/api/comfyui/start` | Start the chosen ComfyUI Desktop installation with Desktop's launch arguments and VEIL's folders; the process ends with VEIL |
| `POST` | `/api/comfyui/stop` | Stop only the VEIL-managed process |
| `POST` | `/api/comfyui/restart` | Restart the managed process |
| `POST` | `/api/comfyui/interrupt` | Interrupt active ComfyUI execution |
| `GET` | `/api/comfyui/logs` | Return captured managed-process output |
| `POST` | `/api/comfyui/launcher` | Generate a platform-specific launcher script |

---

## Remote GPU (Google Colab)

Create can render on a Google Colab GPU under the user's own Google account (plan: [COLAB-REMOTE-PLAN.md](../COLAB-REMOTE-PLAN.md)). On Windows VEIL drives Google's Colab CLI (`google-colab-cli`) inside WSL. Sign-in is the CLI's own copy-paste Google flow: VEIL opens the Google link and hands the code to the waiting CLI process; it never reads or stores the token, which the CLI keeps in WSL. VEIL keeps its runtimes in its own CLI session file. Routes that start programs (`install`, `login`, `logout`, WSL setup) answer only to the app on this computer.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/remote/colab/status` | WSL and its distribution, the Colab CLI version, the signed-in account (email, token lifetime), the install job, whether a sign-in is pending, and the remote settings with GPU choices |
| `POST` | `/api/remote/wsl/install` | Start `wsl --install` with elevation; Windows asks for consent and a restart |
| `GET/POST` | `/api/remote/colab/install` | Install or update the Colab CLI inside WSL (uv from its official installer, then `uv tool install -U google-colab-cli`); GET returns the job state and its last output lines |
| `GET` | `/api/remote/colab/update` | The installed CLI version and a newer release, if the CLI knows one |
| `POST` | `/api/remote/colab/login` | Start sign-in and return the Google URL; `signed_in: true` without a URL when the CLI is already signed in |
| `POST` | `/api/remote/colab/login/code` | Body `{"code": "..."}`: hand Google's authorization code to the waiting CLI; the code is not stored |
| `POST` | `/api/remote/colab/logout` | Remove the CLI's saved sign-in in WSL (also signs out the CLI outside VEIL) |
| `GET` | `/api/remote/colab/usage` | Compute-unit balance, the current CU per hour, active assignments and VEIL's runtimes; cached 60 s, `?refresh=1` asks again |
| `GET` | `/api/remote/colab/runtime` | VEIL's Colab runtime: state (`off`, `allocating`, `booting`, `ready`, `stopping`, `error`), GPU, boot stage, active jobs, images done and seconds until the idle auto-stop |
| `POST` | `/api/remote/colab/runtime/start` | Allocate the runtime and boot the worker in the background (Create runs also start it on demand) |
| `POST` | `/api/remote/colab/runtime/stop` | Release the runtime now; runs still waiting on it fail |
| `POST` | `/api/remote/colab/drive/continue` | Resume a pending Drive mount after the user grants access in Google; 409 when no authorization is pending |
| `GET/POST` | `/api/remote/settings` | Where Create runs (`local` or `colab`), the Colab GPU (`G4` default, `A100`, `L4`, `T4`, `H100`) and the idle auto-stop (2-60 minutes, default 10) |

The remote settings `colab.model_cache` boolean defaults to `false` and enables persistent model weights in Google Drive for the next runtime. Runtime status includes `model_cache.enabled`, `model_cache.state` and a transient `model_cache.auth_url` when Google needs consent. Confirm access at the Google URL before POSTing `/api/remote/colab/drive/continue`. The cache path is `My Drive/VEIL/model-cache`; disabling the setting does not delete files or restart an existing runtime.

## Model sources

The Civitai API key that model downloads use, here and for Colab runtimes (Integrations › Model sources). It is kept in the system credential store, like provider API keys; `config.json` holds it only where no credential store is available, and a key an older version saved there moves into the store the first time it is read. No route returns the key. For Colab, VEIL turns each Civitai link into a short-lived signed link locally, so the key never reaches the runtime. Routes that set, check or remove the key answer only to the app on this computer.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/model-sources` | `{"civitai": {"saved", "storage": "system" \| "config" \| null, "secret_store"}}` |
| `POST` | `/api/model-sources/civitai` | Body `{"token": "..."}`: check the key with Civitai (`GET /api/v1/me`) and save it. A key Civitai refuses is not saved (400 `token_rejected`); when Civitai cannot be reached the key is saved with a `warning`. Returns the state and the Civitai `account` (`username`, `member`) |
| `DELETE` | `/api/model-sources/civitai` | Remove the saved key |
| `POST` | `/api/model-sources/civitai/check` | Ask Civitai whose saved key this is; 404 `token_missing` when none is saved |

`POST /api/comfyui/config` still accepts `civitai_api_token` from Create's ComfyUI settings and saves it the same way; an empty value keeps the saved key.

## Create (Simple) API

The Create workspace (`GET /create` or `GET /editor`) runs one fixed model profile, Moody Krea 2
(`krea2_moody_v40`). There is no model choice: the user picks a mode (`text`, `reference`,
`variation`, `edit`), an aspect ratio (a variation keeps the photo's) or the noise level of a
variation, and 1-4 images. The prompt is written by the agent configured on the Integrations
page (`POST /api/simple/agent`) and then queued with `POST /api/simple/generate`; the two steps are
separate so the prompt can be shown, edited and re-run without the agent.

### `GET /api/simple/models`

Returns the Create profile and its ID.

```json
{
  "models": [ { "id": "krea2_moody_v40", "modes": ["text", "reference", "edit"],
                "edit_profiles": [ { "id": "light", "label": "Light edit", "references": 1, "seconds": 115 } ],
                "…": "…" } ],
  "default_model_id": "krea2_moody_v40"
}
```

### `GET /api/simple/ambient`

Returns up to `limit` (1-72, default 36) candidate background images sampled across the registered
library sources.

```json
{
  "items": [ { "id": 3, "file_name": "x.png", "original_url": "/api/original/3",
               "preview_url": "/api/preview/3", "thumbnail_url": "/api/thumbnail/3",
               "width": 1024, "height": 1024 } ]
}
```

### `GET /api/simple/agent-status`

Which model Create runs when none is picked in its agent menu: the default model of Integrations ›
Models; a photo mode with a text-only default prefers a free OpenCode model that sees photos. Also
lists the instruction files the agent follows.

```json
{
  "available": true,
  "text": { "name": "Codex · GPT-6", "kind": "cli", "cli_type": "codex", "model": "gpt-6", "sees_images": true },
  "photo": { "name": "Codex · GPT-6", "kind": "cli", "cli_type": "codex", "model": "gpt-6", "sees_images": true },
  "instruction_files": ["…/app/ai/prompting/content/create/krea2/base.md", "…"]
}
```

### `GET /api/simple/bootstrap`

One-shot bootstrap for the Create page: `profiles`, `default_profile_id`, `ambient_candidates` and
`agent_status`.

Create's agent menu lists `GET /api/ai/models?visible=1`: the models Integrations › Models shows.

### `POST /api/simple/agent`

Lets the agent write the prompt (text, reference and variation modes) or the edit command (edit
mode). A variation gets the same instruction as `reference`: a faithful description of the photo.
The noise level is the user's choice and is not sent to the agent.

```json
{
  "mode": "edit",
  "request": "change her sweater to a black satin camisole",
  "previous_prompt": null,
  "aspect_ratio": "source",
  "reference_image": "data:image/png;base64,…",
  "subject_image": null,
  "agent_host": "codex",
  "agent_model": "gpt-6",
  "agent_variant": "high"
}
```

`agent_host` (`opencode`, `antigravity`, `codex`, `claude` or `api:<provider id>`) and `agent_model`
run a model picked in Create instead of the default model. Omitted `agent_host` means OpenCode for compatibility.
`agent_variant` must be a reasoning level from that model's catalog: OpenCode 2.x receives
`provider/model#variant`, 1.x uses its default; Codex receives `model_reasoning_effort`, Claude
receives `--effort`. Antigravity's chosen level is already encoded in `agent_model`.
The backend validates model/level and photo support again. Errors: `409` `model_unavailable`, `vision_required`,
`cli_unavailable`; `400` `variant_unavailable`.
`previous_prompt` marks a refinement (the agent keeps it except what the request changes).
`subject_image` is the optional second photo of the edit mode; the agent sees both photos side by
side.

**Response (`200`):**

```json
{
  "positive_prompt": "Replace her cream knitted sweater with …",
  "negative_prompt": "",
  "edit_profile": "light",
  "edit_profile_label": "Light edit",
  "seconds_per_image": 115,
  "note": "",
  "agent": { "name": "Codex", "adapter": "codex", "model": "default", "saw_image": true,
             "job_id": 41, "latency_ms": 53000 },
  "mode": "edit", "profile_id": "krea2_moody_v40", "width": 896, "height": 1152
}
```

Errors: `400` `image_required`, `instruction_required`, `prompt_required`, `subject_invalid`;
`409` `no_ai_model` (no model available) and `vision_required` (the reference mode needs a model
that sees photos); `404` `provider_not_found`; `502` with the adapter code (`cli_authentication`,
`provider_error`, `contract_violation`, `free_tier_refused`, …) and `technical_error`. With no
agent configured at all, an installed OpenCode runs a free OpenCode Zen model instead of `409`.

**Streaming (`?stream=1`).** The same request answers with server-sent events once validation has
passed (validation errors stay plain JSON). Every event is one `data: {json}` line:

- `{"event": "progress", "phase": "started", "agent": "OpenCode (Vision)", "model": "…", "sees_images": true}`;
- `{"event": "progress", "phase": "thinking" | "working" | "writing", "log"?: "…", "text"?: "…"}` —
  `log` is a journal line (Codex reasoning summaries and tool calls, Antigravity output) and `text`
  the prompt as soon as the host reports it. OpenCode reports whole parts, not token deltas; Claude
  Code and direct API profiles report only start and finish;
- exactly one closing `{"event": "result", …}` (the plain `200` body) or
  `{"event": "error", "error", "code", "status", "technical_error"}` (`status` is the HTTP status
  the plain request would use).

Comment lines (`: keep-alive`) arrive every 15 s while the agent is silent. Closing the connection
does not stop the agent; its answer is dropped.

### `POST /api/simple/fetch-image`

Downloads an image from a link for a Create reference block (a pasted link, or an image dragged
in from another browser tab, which often arrives as a link only). The browser cannot read most
foreign images (CORS), so the server fetches it: `http`/`https` only, at most 20 MB, and the bytes
must open as an image; formats browsers do not show are converted to PNG.

```json
{ "url": "https://example.com/dress.jpg" }
```

**Response (`200`):** `{ "data_url": "data:image/jpeg;base64,…", "name": "dress.jpg", "width": 1200,
"height": 1600, "size": 248113, "url": "https://example.com/dress.jpg" }` (`url` after redirects).

Errors: `400` `url_invalid`, `413` `image_too_large`, `415` `not_an_image`, `502` `fetch_failed`
(the site could not be reached or answered with an error).

### `GET /api/simple/models/{profile_id}/status`

Health of the profile: installed resources, missing components and ComfyUI nodes against the current
inventory, `modes_ready` per mode and `restart_required`. `profiles/{profile_id}/status` is an
alias. Pass `?refresh=1` to invalidate the cached runtime inventory first. Unknown profiles return
`404`.

```json
{ "profile_id": "krea2_moody_v40", "health": { "status": "ready", "missing_resources": [],
  "missing_nodes": [], "modes_ready": { "text": true, "reference": true, "edit": true } } }
```

### `POST /api/simple/models/{profile_id}/install`

Queues downloads for every missing required resource and installs missing ComfyUI node packs from
their pinned archives. When the ComfyUI path is not configured it answers `409` with
`code: comfyui_path_required` and `open_settings: true`.

**Response (`202` when downloads were queued):**

```json
{
  "ok": true,
  "profile_id": "krea2_moody_v40",
  "model_root": "C:\\ComfyUI\\models",
  "downloads": [ { "id": 12, "filename": "model.safetensors", "display_name": "…" } ],
  "node_packs": [ { "id": "comfyui-krea2edit", "status": "installed" } ],
  "manual_install": [],
  "restart_required": true,
  "unavailable": []
}
```

### `GET /api/simple/downloads`

Lists active and finished downloads, optionally filtered by `?profile_id=`.

```json
{ "items": [ { "id": 12, "filename": "model.safetensors", "status": "downloading",
               "downloaded_bytes": 1048576, "total_bytes": 8388608 } ] }
```

### `POST /api/simple/downloads/{download_id}/pause`

Pauses a download. Unknown IDs return `404`.

**Response:** `{ "item": { "…": "…" } }`

### `POST /api/simple/downloads/{download_id}/resume`

Resumes a paused download. `/retry` is an alias that also restarts a failed download.

### `POST /api/simple/downloads/{download_id}/cancel`

Cancels and removes a download.

### `POST /api/simple/pick-comfyui-directory`

Opens a native folder picker on the same machine. Remote callers receive `403`. On success
`detection` mirrors the result of `POST /api/comfyui/detect`.

```json
{ "cancelled": false, "path": "C:\\ComfyUI_windows_portable", "detection": { "valid": true } }
```

When the user cancels the dialog the response is `{ "cancelled": true }`. If a native picker is not
available the endpoint answers `503` with `code: directory_picker_unavailable`.

### `POST /api/simple/generate`

Queues one ComfyUI prompt per image (consecutive seeds) of the fixed recipe for the mode.

```json
{
  "mode": "edit",
  "prompt": "Replace her cream knitted sweater with …",
  "user_request": "change her sweater to a black satin camisole",
  "negative_prompt": "",
  "edit_profile": "light",
  "aspect_ratio": "source",
  "batch_size": 2,
  "seed": -1,
  "reference_image": "data:image/png;base64,…",
  "subject_image": null,
  "agent_name": "Codex"
}
```

`prompt` is required (written by the agent or by hand). `reference_image` is required in the
`reference`, `variation` and `edit` modes; `edit_profile`, `subject_image` and `negative_prompt` are
edit-only. `variation` starts from the photo itself (image to image): the photo is scaled to about
1 MP in its own proportions (multiples of 16) and `denoise` (0-1, default 0.65, variation-only) sets
how much of it is repainted from the prompt; 1.0 keeps only its proportions. The prompt for a
variation is the same faithful description of the photo the agent writes in `reference` mode.
The request, the prompt, the agent, the edit profile and the noise level are stored in the draft and
in the PNG metadata (`mediastudio_user_request`, `mediastudio_prompt`, `mediastudio_agent`, `mediastudio_edit_profile`,
`mediastudio_denoise`). Every result also lands in ComfyUI's output folder (`MediaStudio/Create`), including runs on
Colab: VEIL copies them there under the next free ComfyUI-style name.

**Response (`200`):**

```json
{
  "ok": true,
  "run_id": 7,
  "run_ids": [7, 8],
  "runs": [ { "run_id": 7, "prompt_id": "a1b2…", "seed": 11 } ],
  "requested": 2,
  "mode": "edit",
  "edit_profile": "light",
  "denoise": null,
  "seconds_per_image": 115,
  "width": 896,
  "height": 1152,
  "positive_prompt": "…",
  "negative_prompt": ""
}
```

Errors: `400` `mode_unsupported`, `image_required`, `instruction_required`, `prompt_required`,
`edit_profile_invalid`, `subject_invalid`, `edit_only`, `variation_only`; `409` `model_not_installed` with
`missing_resources`, `restart_required` / `nodes_missing` with `missing_nodes`; `502`
`comfyui_rejected`; `503` `comfyui_connection_failed`.

### `GET /api/simple/runs/{run_id}`

Refreshes remote ComfyUI state and returns the run plus imported output assets.

```json
{
  "run": { "id": 7, "status": "completed", "output_asset_ids": [42], "…": "…" },
  "status": "completed",
  "outputs": [ { "id": 42, "filename": "…", "preview_url": "/api/preview/42",
                 "thumbnail_url": "/api/thumbnail/42", "width": 1024, "height": 1024 } ],
  "is_complete": true,
  "live": { "state": "finished", "stage": "done", "node_class": "SaveImage", "step": 8, "steps": 8,
            "elapsed_seconds": 54.1, "eta_seconds": 0, "duration_seconds": 54.1, "outcome": "success" }
}
```

`live` comes from the ComfyUI WebSocket: Create queues its runs with one client id per ComfyUI
address and keeps a connection open while runs are active (ComfyUI reports steps only to the
queuing client). `state` is `queued` / `running` / `finished`; `stage` is `queued`, `loading`,
`encoding`, `sampling`, `decoding`, `saving`, `working` or `done`; `step` / `steps` count sampler
steps across all sampler nodes of the graph (`steps` from the compiled workflow); `eta_seconds`
uses the measured time per step plus the decode-and-save tail and is `null` before sampling
starts; `duration_seconds` is the execution time from start to finish. `live` is `null` when the
run was not seen on the socket (another client, ComfyUI restarted, the monitor could not connect).

### `POST /api/simple/runs/{run_id}/cancel`

Cancels a pending or running generation for this run.

**Response:** `{ "ok": true, "run": { "…": "…" } }`

---

## Social API

Social routes are present, but publishing is **not implemented for any provider**; every publisher
reports `implemented: false` and publish requests answer `501` with `code: not_implemented`. The
integration page shows provider cards and authentication flows only.

### `GET /api/social/status`

Returns capability and credential status for all providers.

```json
{
  "providers": {
    "telegram": { "label": "Telegram", "implemented": false, "enabled": true, "publisher": null },
    "vk": { "label": "VK", "implemented": false, "enabled": false, "publisher": null }
  }
}
```

### `GET /api/social/{provider}/status`

Same payload for one provider. Unknown providers return `404` with `code: unknown_provider`.

### `POST /api/social/publish` and `POST /api/social/{provider}/publish`

Validate and dispatch a publish request. Payload validation failures return `400` with
`code: invalid_payload`; unimplemented publishers return `501` with `code: not_implemented`.

The request contract is shared by both routes and includes `provider`, `target`, one to ten `assets`, and optional `text`. The path-selected route additionally verifies that the URL provider matches the payload provider.

### Telegram auth flow

`POST /api/social/telegram/auth/start`, `GET /api/social/telegram/auth/state`,
`GET /api/social/telegram/auth/qr.png`, `POST /api/social/telegram/auth/code`,
`POST /api/social/telegram/auth/password`, `POST /api/social/telegram/auth/cancel`, and
`POST /api/social/telegram/auth/disconnect` implement the phone/QR login sequence. They require
Telegram API credentials (`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`).

### VK auth flow

`POST /api/social/vk/auth/start`, `GET /api/social/vk/auth/callback`, and
`POST /api/social/vk/auth/disconnect` handle the OAuth exchange. VK OAuth is limited to port `80`
on `localhost`, which the app cannot self-host.

---

## Data Models

### `ImageMetadata`

```json
{
  "file": "string",
  "path": "string",
  "format": "string | null",
  "size": "int[] | null",
  "mode": "string | null",
  "error": "string | null",
  "exif": "object | null",
  "prompt_parameters": "object | null",
  "workflow": "object | null",
  "prompt_api_json": "object | null",
  "workflow_ui_json": "object | null",
  "raw_parameters": "string | null"
}
```

### `ImageListItem`

```json
{
  "id": "int | null",
  "file_name": "string",
  "format": "string | null",
  "size": "int[] | null",
  "mode": "string | null",
  "error": "string | null",
  "thumbnail": "string | null",
  "file": "string | null",
  "path": "string | null",
  "rating": "int | null"
}
```

### `ImageDetail`

`ImageDetail` extends `ImageListItem` with:

```json
{
  "prompt_parameters": "object | null",
  "workflow": "object | null",
  "exif": "object | null",
  "raw_chunks": "object | null",
  "raw_parameters": "string | null",
  "raw_params": "string | null",
  "folder_id": "int | null"
}
```

### `ScanResponse`

```json
{
  "folder_id": "int",
  "folder": "FolderInfo | null",
  "page": "int",
  "per_page": "int",
  "total": "int",
  "images": "ImageListItem[]",
  "cached": "int",
  "processed": "int"
}
```
