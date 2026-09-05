# opencode-vision-analyze

[![npm](https://img.shields.io/npm/v/opencode-vision-analyze)](https://www.npmjs.com/package/opencode-vision-analyze)
[![license](https://img.shields.io/npm/l/opencode-vision-analyze)](./LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai/docs/plugins)

A tool-based vision routing plugin for [opencode](https://opencode.ai): when the main model can't see images, it calls the `vision_analyze` tool on demand — your dedicated vision model describes the image and the description flows straight back into the conversation. When the main model already supports images, pasted images pass through untouched and the tool short-circuits to return raw pixels.

**Zero runtime dependencies.** Only node builtins (`crypto`/`fs`/`path`) and type-only imports — nothing to install beyond the plugin itself.

## Why this one

There are already a few vision plugins in the ecosystem. The differences:

| | opencode-vision | opencode-vision-router | opencode-image-vision | **opencode-vision-analyze** |
|---|---|---|---|---|
| Mechanism | skill + subagent delegation | pointer + subagent delegation | direct SDK call (read-image / read-ocr) | **tool + plugin-managed sub-session** |
| Vision model source | auto-discovered image models | single `model` option | per-feature provider/model | single `model` option |
| Main-model capability detection | models.dev catalog + auth | `chat.params` live learning | name regex (fragile) | `config.providers()` capabilities (cached) |
| Image persistence | /tmp (session+part hash) | tmpDir | user dir / clipboard dir | `.opencode/vision/` content-addressed sha256 |
| Output | subagent answers itself | subagent answers itself | description / OCR text | description text (with cache) |
| Vision-capable main model | skip registration | skip routing (`force` to override) | skipModels / forceDescription | skip injection + **native fast path** (tool returns the raw image as attachment) |
| Request path | opencode session | opencode session | **direct third-party SDK** | opencode sub-session (unified auth, no extra credentials) |
| Failure visibility | via subagent tool chain | via subagent | tool output | tool output (never throws) |

Highlights:

- **Tool-based, not pre-analysis.** The turn starts immediately; the model decides when (and with which question) to look. No blocking on submit, failures are visible and retryable inside the agent loop. Same philosophy as production-proven agent designs.
- **Question-aware descriptions.** The model passes its own focused question to `vision_analyze` — not a one-shot generic caption computed at submit time.
- **Native fast path.** If the main model is vision-capable, `vision_analyze` skips the vision model entirely and returns the raw image as a tool attachment.
- **Content-addressed cache.** Images are stored as `<sha256>.<ext>` (deduped across sessions); descriptions are cached per `<image-hash>:<question>` — the same image with the same question is described exactly once.
- **Unified auth.** The vision call runs through an opencode sub-session, so it reuses the provider credentials opencode already manages. No extra API key plumbing.

## Requirements

- [opencode](https://opencode.ai) (plugins are loaded with Bun; npm plugins are installed automatically at startup)
- a vision model you have access to, referenced as `provider/model` (e.g. `"openai/gpt-4o-mini"`, `"anthropic/claude-sonnet-4-5"`)
- supported image extensions: png / jpg / jpeg / gif / webp

## Installation

### Option A — npm (recommended)

```jsonc
// opencode.json (project or global)
{
  "plugin": [
    ["opencode-vision-analyze", { "model": "openai/gpt-4o-mini" }]
  ]
}
```

opencode installs npm plugins automatically at startup.

### Option B — curl single file (no npm)

The plugin is a single self-contained TypeScript file with zero runtime dependencies — you can just download it:

```bash
mkdir -p .opencode
curl -fsSL https://raw.githubusercontent.com/MwumLi/opencode-vision-analyze/v0.1.0/src/index.ts \
  -o .opencode/vision-analyze.ts
```

```jsonc
// opencode.json
{
  "plugin": [
    ["./.opencode/vision-analyze.ts", { "model": "openai/gpt-4o-mini" }]
  ]
}
```

Notes for the curl path:

- The URL above pins release tag `v0.1.0` for stability; upgrading = re-run curl against the newer tag or `main`.
- The file is TypeScript source — opencode loads plugins with Bun, so this works as-is.
- Options must be passed via the `plugin` tuple (the auto-discovered `.opencode/plugins/` directory can't carry options).

### Options

| Option | Required | Default | Description |
|---|---|---|---|
| `model` | yes | — | Vision model in `provider/model` format, e.g. `"anthropic/claude-sonnet-4-5"`, `"openai/gpt-4o-mini"` |
| `timeout_ms` | no | `60000` | Timeout (ms) for vision sub-session requests |

## How it works

```
User pastes image + question
 └─ chat.message hook (before persist)
     ├─ main model has image input capability → do nothing (raw image goes to model)
     └─ text-only main model → persist image to .opencode/vision/<sha256>.<ext>
        and inject a synthetic hint (hidden in TUI, visible to model):
        "use the vision_analyze tool with image_path: ..."

Main model processes:
 ├─ vision-capable: sees the original image directly (zero cost)
 └─ text-only: sees the hint, calls vision_analyze(image_path, question)

vision_analyze tool:
 ├─ native fast path: session's main model is vision-capable
 │    → return raw image as attachment (no vision model call)
 ├─ http(s) image URL → download (20 MB cap) → same disk path
 ├─ description cache hit (sha + question) → return cached text
 └─ sub-session: parentID under current session, all tools disabled,
     dedicated system prompt, image + question sent to YOUR vision model
     → description text returned → sub-session deleted immediately
```

Key behaviors:

- **Capability gating** — queries `config.providers()` capabilities; results cached per process. A vision-capable main model never gets hints or routing.
- **Recursion guard** — the vision model's own messages (from the sub-session) are never re-processed.
- **The tool never throws** — every failure returns readable text so the agent loop can retry, rephrase, or inform the user.
- **URL images** — `image_path` accepts `http(s)://...` URLs (must end in a supported image extension: png/jpg/jpeg/gif/webp).

## Known limitations

- **V1 session flow only** — hooks are attached to the V1 `SessionPrompt` path; if opencode's default interaction moves to the V2 session core, hooks won't fire (silently).
- **SSRF surface** — URL downloads follow redirects and don't block private-range / cloud-metadata addresses. Acceptable for a local single-user CLI; add address filtering before using in multi-tenant environments.
- **Abort doesn't propagate** — user aborts don't cancel in-flight downloads/sub-session requests; they run to their own deadlines (30s download, `timeout_ms` sub-session). After timeout/abort the sub-session is deleted, but the orphan turn may still be billed by the provider.
- **Historical images** — images from messages sent before the plugin was enabled can't be described (no hint, no path on disk).
- **Unbounded caches** — both the image store and description cache grow without eviction (per process / per project dir).
- **Single model, no fallback chain** — one explicit `model` option; if it fails, the tool returns an error message instead of trying other providers.

## Roadmap

- [ ] `model: undefined` fallback for first messages without an explicit model
- [ ] Timeout wrapping for the capability query (`config.providers()`)
- [ ] Abort sub-session (`/session/{id}/abort`) before delete on timeout
- [ ] LRU / size cap for the description cache
- [ ] Optional private-address blocking for URL downloads
- [ ] Region cropping for zooming into image details

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests (stub client, no opencode needed)
bun run build       # tsc → dist/
```

The unit tests stub the plugin input/client — no running opencode instance is required.

## License

[MIT](./LICENSE)
