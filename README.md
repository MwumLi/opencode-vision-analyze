# opencode-vision-analyze

[![npm](https://img.shields.io/npm/v/opencode-vision-analyze)](https://www.npmjs.com/package/opencode-vision-analyze)
[![license](https://img.shields.io/npm/l/opencode-vision-analyze)](./LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai/docs/plugins)

English | [简体中文](./README.zh.md)

A tool-based vision routing plugin for [opencode](https://opencode.ai): when the main model can't see images, it calls the `vision_analyze` tool on demand — your dedicated vision model describes the image and the description flows straight back into the conversation. When the main model already supports images, pasted images pass through untouched and the tool short-circuits to return raw pixels.

**Zero runtime dependencies.** Only node builtins (`crypto`/`fs`/`path`) and type-only imports — nothing to install beyond the plugin itself.

## Features

- **Tool-based, not pre-analysis.** The turn starts immediately; the model decides when (and with which question) to look. No blocking on submit, failures are visible and retryable inside the agent loop. Same philosophy as production-proven agent designs.
- **Question-aware descriptions.** The model passes its own focused question to `vision_analyze` — not a one-shot generic caption computed at submit time. For a general parse of an image the model leaves `question` empty, and the tool falls back to a fixed prompt so all generic descriptions of the same image share one cache entry (see *Content-addressed cache*).
- **Native fast path.** If the main model is vision-capable, `vision_analyze` skips the vision model entirely and returns the raw image as a tool attachment.
- **Content-addressed cache.** Images are stored as content-addressed `<sha256>.<ext>` files in a **user-level shared directory** (`<cache>/opencode-vision-analyze/vision`, deduped across projects/sessions, LRU-capped 2000 entries / 500 MB); descriptions are cached per `<image-hash>:<question>` in a **user-level shared directory** (`<cache>/opencode-vision-analyze/descriptions`) — the same image with the same question is described exactly once, across projects, processes, and plugin restarts. The description cache is LRU-capped (2000 entries / 50 MB). Generic full-image parses (empty or omitted `question`) are normalised to a fixed prompt and all land on a single `<image-sha>:Describe this image in full detail.` key, so the same "parse this image" request hits the cache across sessions when the main model omits the question or passes an equivalent wording.
- **Unified auth.** The vision call runs through an opencode sub-session, so it reuses the provider credentials opencode already manages. No extra API key plumbing.

## Installation

### Option A — npm (recommended)

```jsonc
// opencode.json (project or global)
{
  "plugin": [
    ["opencode-vision-analyze", { "models": ["openai/gpt-4o-mini"] }]
  ]
}
```

opencode installs npm plugins automatically at startup.

### Option B — curl single file (no npm)

The plugin is a single self-contained TypeScript file with zero runtime dependencies — you can just download it:

```bash
mkdir -p .opencode
curl -fsSL https://raw.githubusercontent.com/MwumLi/opencode-vision-analyze/main/src/index.ts \
  -o .opencode/vision-analyze.ts
```

```jsonc
// opencode.json
{
  "plugin": [
    ["./.opencode/vision-analyze.ts", { "models": ["openai/gpt-4o-mini"] }]
  ]
}
```

Notes for the curl path:

- The URL above points at the `main` branch (latest source); for a pinned release, swap `main` for a release tag (e.g. `v0.1.0`) and re-run curl.
- The file is TypeScript source — opencode loads plugins with Bun, so this works as-is.
- Options must be passed via the `plugin` tuple (the auto-discovered `.opencode/plugins/` directory can't carry options).

### Options

| Option | Required | Default | Description |
|---|---|---|---|
| `models` | no | — | Ordered candidate list of vision models (`provider/model`), tried one after another until one succeeds. A single vision model is written as `models: ["..."]`. When omitted (or an empty array) the plugin auto-discovers all image-capable models. |
| `unlisted_fallback` | no | `false` | When an explicit `models` chain is configured and it is exhausted, keep going with image-capable models that were not listed. |
| `free_first` | no | `false` | In auto-discovery, prefer anonymous/built-in free providers (`custom` source) ahead of config-defined ones — reverses the source-tier order. |
| `timeout_ms` | no | `60000` | Timeout (ms) budget for each individual `create`/`prompt` request inside the vision sub-session |

Supported image extensions: png / jpg / jpeg / gif / webp.

Image storage: stored in a **user-level shared directory** `<cache>/opencode-vision-analyze/vision` regardless of git scope — one content-addressed `<sha256>.<ext>` file per unique image, shared across all projects. Pasted images and `http(s)` downloads are written here (atomic temp-file + rename, so concurrent opencode processes can safely share the store); **already-local image paths passed straight to the tool are read in place and never copied**. Defaults per platform: Linux `$XDG_CACHE_HOME || ~/.cache`, macOS `~/Library/Caches` (a `$XDG_CACHE_HOME` override is honored), Windows `%LOCALAPPDATA% || ~/AppData/Local`. An empty cache-root env var is treated as unset (falls back to the default). The store is LRU-capped (2000 entries / 500 MB; oldest by file mtime is evicted when either limit is exceeded), so no `.gitignore` entry is needed anywhere.

Description cache: stored in a **user-level shared directory** `<cache>/opencode-vision-analyze/descriptions` regardless of git scope — one JSON entry per `<image-sha>:<effective-question>` key, named by `sha256(key)`. `question` is optional on the tool: a general full-image parse (empty or omitted) is normalised to the fixed prompt `Describe this image in full detail.`, so every such request uses the key `<image-sha>:Describe this image in full detail.` when its wording normalises to that prompt; specific follow-ups keep their own `<image-sha>:<question>` keys (format unchanged, existing entries keep hitting). Generic entries are only written when the description is long enough (≥ 100 chars), so a short refuse/fail answer can't poison the shared full-image entry. It is capped at 2000 entries / 50 MB with LRU eviction (oldest by file mtime is removed when either limit is exceeded). Writes are atomic (temp file + rename), so concurrent opencode processes can safely share the cache.

An ordered-candidates example with auto-fallback and free-first discovery:

```jsonc
// opencode.json
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

## How it works

```
User pastes image + question
 └─ chat.message hook (before persist)
     ├─ message model ∈ candidate chain → do nothing (recursion guard)
     ├─ main model has image input capability → do nothing (raw image goes to model)
     ├─ no image-capable model available → do nothing (no hint, no persist;
     │    core's default image handling applies)
     └─ text-only main model → persist image to the user-level vision store
        (<sha256>.<ext> under <cache>/opencode-vision-analyze/vision;
         already-local file paths are read in place, never copied)
        and inject a synthetic hint (hidden in TUI, visible to model):
        "use the vision_analyze tool with image_path: ..."

Main model processes:
 ├─ vision-capable: sees the original image directly (zero cost)
 └─ text-only: sees the hint, calls vision_analyze(image_path, question)

vision_analyze tool:
 ├─ native fast path: session's main model is vision-capable
 │    → return raw image as attachment (no vision model call)
 ├─ http(s) image URL → download (20 MB cap) → same disk path
 ├─ description cache hit (image sha + effective question) → return cached text
 │    (general parses converge on <sha>:<canonical full-detail prompt>;
 │     persisted under <cache>/opencode-vision-analyze/descriptions,
 │     tagged with the model that produced it, LRU-capped 2000 entries / 50 MB)
 └─ candidate chain: sub-session under current session per candidate, in order —
      parentID, all tools disabled, dedicated system prompt, image + question
      sent to that vision model → first success returns → sub-session deleted
```

Key behaviors:

- **Capability gating** — queries `config.providers()` capabilities; results cached per process. A vision-capable main model never gets hints or routing.
- **Candidate chain** — the `models` list is tried in order until one succeeds. Explicit models always head the chain. With no explicit config (or an empty `models` list) the plugin auto-discovers every image-capable model, ordered by provider source (config first, then env/api, then custom/anonymous; reversed with `free_first: true`). With `unlisted_fallback: true`, an exhausted explicit chain continues onto unlisted image-capable models.
- **Recursion guard (whole chain)** — messages from the candidate chain's own sub-sessions are never re-processed.
- **Empty chain degradation** — if no vision model is available at all, the plugin still loads: pasted images are left untouched (no hint injected) and the tool returns a clear error instead of routing.
- **Loginless free models** — auto-discovery uses `config.providers()`, the same source as the `/models` picker, so image-capable zen free models are found even without login (their provider is `custom` source → default last tier; put them first with `free_first: true`).
- **The tool never throws** — every failure returns readable text so the agent loop can retry, rephrase, or inform the user.
- **URL images** — `image_path` accepts `http(s)://...` URLs (must end in a supported image extension: png/jpg/jpeg/gif/webp).
- **General parses share one cache entry** — `question` is optional and empty/omitted values are normalised to a fixed full-image prompt, so a repeated "parse this image" hits the disk cache across sessions when the main model omits the question or passes an equivalent wording. Specific follow-ups (an object/text/region/color) keep their own exact-key entries.

## Known limitations

- **V1 session flow only** — hooks are attached to the V1 `SessionPrompt` path; if opencode's default interaction moves to the V2 session core, hooks won't fire (silently).
- **General-parse descriptions are English.** The canonical full-image prompt is fixed English; the returned description follows that language, and the main model is expected to relay it in the user's language.
- **The canonical prompt is a contract.** `GENERIC_QUESTION` is baked into cache keys: changing its wording makes old generic entries unreachable (they age out via LRU). Deliberate — lets the prompt evolve or be customised per user/scenario without stale hits.
- **Model non-compliance still costs once.** If the main model ignores the hint and passes a reworded generic question, it creates its own exact entry (one extra vision call, no wrong answers). Omission is the natural, hinted path.
- **Switching vision models does not re-run general parses.** A generic entry is not re-computed just because the candidate chain changed; to force a fresh description, pass a non-canonical specific question once.

## Roadmap

- [ ] Region cropping for zooming into image details

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests (stub client, no opencode needed)
bun run build       # tsc → dist/
```

The unit tests stub the plugin input/client — no running opencode instance is required.

## Release

Versioning is driven entirely by `npm version` — no manual `package.json` edits. It updates the version, creates a commit and an annotated `v<version>` tag, and (via hooks) runs a local gate then pushes to trigger the GitHub release workflow that publishes to npm.

```bash
npm version patch                      # 0.1.x → 0.1.(x+1): commit + tag v0.1.x, auto-push → release
npm version 1.2.0                      # explicit full version
npm version prerelease --preid beta    # beta smoke: 0.1.1 → 0.1.2-beta.0
```

Hooks configured in `package.json`:

- `preversion` — runs `typecheck && test && build` locally; if any fails the version is not bumped or tagged.
- `postversion` — `git push --follow-tags`; pushes the commit and its tag, which triggers the GitHub Actions `release.yml` (`on.push.tags: ["v*"]`) that runs the checks again and `npm publish --access public` using the `NPM_TOKEN` secret.

Beta smoke → stable flow:

```bash
npm version prerelease --preid beta   # publish a beta to npm
# verify the beta on npm, then:
npm version patch                      # drops the pre-release and bumps to the stable version
```

Escape hatches: `npm version 1.2.3 --no-git-tag-version` (only bump the file) or `--ignore-scripts` (skip all hooks). `npm version` requires a clean working tree. If the `postversion` push fails, run `git push --follow-tags` manually.

## License

[MIT](./LICENSE)
