# Installation Guide (for OpenCode agents)

This document is written to be read and executed by an **OpenCode agent** on behalf of a
user. It installs and configures [`opencode-vision-analyze`](https://github.com/MwumLi/opencode-vision-analyze)
— a plugin that lets a text-only main model "see" images by calling the `vision_analyze`
tool, which routes the image to a vision-capable model.

If you are a human reading this, you can either follow the steps yourself or paste the
prompt from the README into your OpenCode session and let the agent do it.

---

## What the agent must know

- `opencode-vision-analyze` is an **npm plugin** enabled through the `plugin` array in
  `opencode.json` / `opencode.jsonc`. It has **no separate config file**.
- Its behavior is tuned by **plugin options** passed as the second element of the `plugin`
  tuple: `models`, `unlisted_fallback`, `free_first`, `timeout_ms`, `crop_command`.
- All options are optional. With no options, the plugin auto-discovers every
  image-capable model already configured in opencode.
- The plugin is **zero-runtime-dependency** and reuses opencode's existing provider
  credentials through a sub-session — no API key plumbing is required.
- The `vision_analyze` tool also supports an optional `region` crop, which shells out to
  ImageMagick (`magick`/`convert`) or `ffmpeg`. Those are **optional**; full-image analysis
  works without them.

## Prerequisites

1. OpenCode CLI or Desktop installed.
2. At least one **image-capable model** available in opencode (e.g. an OpenAI/Anthropic
   vision model, a local model, or a free zen model). Run `opencode models` or check the
   `/models` picker if unsure.
3. Optional, for `region` cropping: ImageMagick or ffmpeg installed on the host.

---

## Step 1 — Ask the user for the install scope

Do **not** assume. Ask which scope they want:

- **Global** (applies to every project): `~/.config/opencode/opencode.json`
  (or `opencode.jsonc`).
- **Project** (this repository only): `opencode.json` in the project root. OpenCode also
  traverses upward to the nearest Git root looking for it.

Prefer the scope the user names. If they don't care, **global** is the safer default for a
general-purpose tool.

## Step 2 — Read the existing config

1. Locate the config file for the chosen scope. Both `.json` and `.jsonc` (JSON with
   comments) are valid.
2. If it exists, read it in full and **preserve every existing key** — especially an
   existing `plugin` array and `provider`/`model` settings.
3. If it does not exist, you will create a minimal one.

Never delete or rewrite unrelated configuration. If you are about to edit an existing
file, back it up first (e.g. copy it to `<name>.bak`).

## Step 3 — Add the plugin entry

Merge `opencode-vision-analyze` into the existing `plugin` array. **Do not replace the
array** — append to it. The array accepts both plain strings and `[name, options]` tuples.

### Option A — npm (recommended)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // ...any existing plugins...
    ["opencode-vision-analyze", { "models": ["<provider>/<vision-model>"] }]
  ]
}
```

opencode installs npm plugins automatically with Bun at startup; nothing else to run.

### Option B — no npm (single file)

If the user prefers not to use npm, download the self-contained TypeScript source and
reference it locally. The plugin has zero runtime dependencies, and opencode loads it with
Bun as-is.

```bash
mkdir -p .opencode
curl -fsSL https://raw.githubusercontent.com/MwumLi/opencode-vision-analyze/main/src/index.ts \
  -o .opencode/vision-analyze.ts
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./.opencode/vision-analyze.ts", { "models": ["<provider>/<vision-model>"] }]
  ]
}
```

Note: the auto-discovered `.opencode/plugins/` directory cannot carry options, so the
tuple form above (with an explicit path) is required.

## Step 4 — Choose the vision model(s)

Ask the user whether they have a preferred vision model.

- **They name one or more** → set `models` to an **ordered** list of `provider/model`
  strings. Candidates are tried in order until one succeeds.
- **They have no preference** → **omit `models` entirely**. The plugin auto-discovers every
  image-capable model opencode already knows about.

Supported plugin options:

| Option | Required | Default | Description |
|---|---|---|---|
| `models` | no | — | Ordered candidate list of vision models (`provider/model`), tried in order until one succeeds. Omit (or empty) to auto-discover all image-capable models. |
| `unlisted_fallback` | no | `false` | When an explicit `models` chain is exhausted, continue with image-capable models not listed. |
| `free_first` | no | `false` | In auto-discovery, prefer anonymous/built-in free providers (`custom` source) ahead of config-defined ones. |
| `timeout_ms` | no | `60000` | Per-request timeout budget (ms) inside the vision sub-session. |
| `crop_command` | no | — | Executable used for region cropping (e.g. `/usr/bin/ffmpeg`); auto-detected as `magick` → `convert` → `ffmpeg` when omitted. |

Example with an ordered chain, fallback, and free-first discovery:

```jsonc
{
  "plugin": [
    [
      "opencode-vision-analyze",
      {
        "models": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"],
        "unlisted_fallback": true,
        "free_first": true
      }
    ]
  ]
}
```

## Step 5 — Optional: region-crop dependencies

`vision_analyze` accepts an optional `region` (normalized `0–1000` `[x1,y1,x2,y2]`) to zoom
into fine detail by cropping **before** downscaling. Cropping needs one of:

- ImageMagick (`magick` or `convert`) — preferred
- ffmpeg

Check whether one is installed (e.g. `command -v magick convert ffmpeg`). If none is
present, tell the user that full-image analysis still works and ask whether they want
region cropping; offer the platform-appropriate install command if they do. Do not install
system packages without explicit consent.

## Step 6 — Verify

1. Confirm the edited file still parses as JSON/JSONC. If the user's project has a JSON
   toolchain available, prefer that; otherwise re-read the file and check it carefully.
2. Show the user the exact change (the added `plugin` entry) and the file path.
3. Tell the user to **restart OpenCode** (or switch models with `/model` to trigger a
   reload) so the plugin is picked up.
4. Verify it works: start a chat, paste an image, and confirm the model calls the
   `vision_analyze` tool (or, if the main model is itself vision-capable, that the image
   passes through untouched).

## Guardrails

- Never overwrite or remove unrelated keys, existing plugins, providers, or credentials.
- Back up any config file before editing it.
- Never invent provider or model IDs — use ones the user confirms or that opencode reports.
- Never write secrets/API keys into the config as part of this install.
- If the user's config is managed/enforced by their organization (e.g. `/etc/opencode/`,
  MDM), stop and explain that the plugin must be added by their administrator.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Images are ignored, no `vision_analyze` hint | No image-capable model available, or the plugin wasn't loaded — restart OpenCode and confirm the `plugin` entry parses. |
| "model not found" errors | A `models` entry has a wrong `provider/model` ID — check the `/models` picker or remove `models` to auto-discover. |
| `region` returns an error | ImageMagick/ffmpeg is not installed. Install one, or omit `region` (full-image analysis still works). |
| Plugin appears not to load at all | Confirm the config file is in the right location for the chosen scope and that the JSON(C) is valid. |

## Reference

- Repository: https://github.com/MwumLi/opencode-vision-analyze
- npm: https://www.npmjs.com/package/opencode-vision-analyze
- opencode plugins: https://opencode.ai/docs/plugins
- opencode config: https://opencode.ai/docs/config
