# opencode-vision-analyze

[![npm](https://img.shields.io/npm/v/opencode-vision-analyze)](https://www.npmjs.com/package/opencode-vision-analyze)
[![license](https://img.shields.io/npm/l/opencode-vision-analyze)](./LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai/docs/plugins)

[English](./README.md) | 简体中文

一个面向 [opencode](https://opencode.ai) 的工具化视觉路由插件：当主模型看不了图片时，由它按需调用 `vision_analyze` 工具——你指定的视觉模型描述图片，描述文字直接回到对话中。当主模型本身支持图片时，贴图原样直发，工具短路返回原图。

**零运行时依赖。** 只用 node 内置模块（`crypto`/`fs`/`path`）和纯类型导入——除插件本身外无需安装任何东西。

## 特性

- **工具化，而非提交时预分析。** 轮次即时启动；模型自己决定何时看图、带着什么问题看。提交零阻塞，失败在 agent 循环里可见、可重试。
- **描述针对问题。** 模型把自己关注的问题传给 `vision_analyze`——而不是提交时预生成的一次性通用描述。若只是让描述整张图，模型留空 `question`，工具用固定文案兜底，使同一张图的泛描述共享一条缓存（见"内容寻址缓存"）。
- **原生快速路径。** 主模型本身有视觉能力时，`vision_analyze` 完全跳过视觉模型，直接把原图作为工具附件返回。
- **内容寻址缓存。** 图片与描述按内容哈希落到用户级共享目录，跨会话 / 项目 / 重启复用——同一张图不会重复付费描述；同一张图的所有泛解析请求都收敛到同一条缓存。存储路径、容量上限与固定文案详见下文「存储与缓存」。
- **统一鉴权。** 视觉调用走 opencode 子会话，复用 opencode 已管理的 provider 凭据，无需额外配置 API Key。

## 安装

### 方式 A —— npm（推荐）

```jsonc
// opencode.json（项目级或全局）
{
  "plugin": [
    ["opencode-vision-analyze", { "models": ["openai/gpt-4o-mini"] }]
  ]
}
```

opencode 启动时会自动安装 npm 插件。

### 方式 B —— curl 单文件（免 npm）

本插件是零运行时依赖的单文件 TypeScript 源码，直接下载即可使用：

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

curl 方式说明：

- 上方 URL 指向 `main` 分支（最新源码）；如需固定版本，把 `main` 换成发布 tag（如 `v0.1.0`）再重新 curl。
- 文件是 TypeScript 源码——opencode 用 Bun 加载插件，直接可用。
- 选项必须通过 `plugin` 元组传入（`.opencode/plugins/` 自动发现目录无法携带选项）。

### 选项

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `models` | 否 | — | 有序候选视觉模型数组（`provider/model`），逐个尝试直到成功即止；单个视觉模型写作 `models: ["..."]`。缺省或空数组时自动发现全部 image-capable 模型。 |
| `unlisted_fallback` | 否 | `false` | 显式 `models` 链耗尽后，自动续试未列入清单的 image-capable 模型。 |
| `free_first` | 否 | `false` | 自动发现时优先匿名/内置免费（`custom` 源）provider，置于 config 源之前——反转 source 档序。 |
| `timeout_ms` | 否 | `60000` | 子会话内每次 create/prompt 请求各自的超时预算（毫秒） |

受支持的图片扩展名：png / jpg / jpeg / gif / webp。

有序候选 + 自动续接 + 免费优先的配置示例：

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

### 存储与缓存

两套**用户级共享缓存**并列在 `<cache>/opencode-vision-analyze/` 下，跨会话 / 项目 / 重启共享，与 git 分域无关，无需任何 `.gitignore`。

| 缓存 | 目录 | 内容 | 命名 | 容量上限 |
|---|---|---|---|---|
| 图片 | `vision/` | 图片字节 | `<sha256>.<ext>` | 2000 条 / 500MB |
| 描述 | `descriptions/` | 描述文本（JSON） | `sha256(key)` | 2000 条 / 50MB |

**图片存储（`vision/`）**

- **写入缓存**：剪贴板位图（无源路径）与 `http(s)` 下载。
- **原位读用（不复制）**：路径粘贴（消息 part 带真实 `source.path`，如复制到剪贴板的文件路径）与模型直接传入的本地文件路径——分析时当场重读，故同一路径每次粘贴都取最新内容。
- **淘汰**：按文件 mtime LRU；超出 2000 条或 500MB 即删最久未用的条目。
- **并发安全**：临时文件 + rename 原子写，多个 opencode 进程可安全共享。

**描述缓存（`descriptions/`）**

- **key**：`<图片sha256>:<生效问题>`，文件名取 `sha256(key)`。
- **泛解析（`question` 空 / 省略）**：归一化到固定文案 `Describe this image in full detail, including all text, UI elements, diagrams, or content visible.`，所有泛解析收敛到同一条。
- **具体追问**：保留原问句，走各自的 `<图片sha256>:<问题>` key（格式与旧版一致，存量条目照常命中）。
- **写入门槛**：泛解析条目要求描述 ≥ 100 字符，防止视觉模型敷衍/拒答的短文本毒化共享条目。
- **淘汰**：按文件 mtime LRU，上限 2000 条 / 50MB；**并发安全**同上。

**平台默认缓存根**

- Linux：`$XDG_CACHE_HOME || ~/.cache`
- macOS：`~/Library/Caches`（亦接受 `$XDG_CACHE_HOME` 覆盖）
- Windows：`%LOCALAPPDATA% || ~/AppData/Local`
- 空串 env 视为未设置，回退默认。

## 工作原理

```
用户贴图 + 提问
 └─ chat.message 钩子（消息持久化前）
     ├─ 消息模型 ∈ 候选链 → 不做任何处理（递归防护）
     ├─ 主模型支持图片输入 → 不做任何处理（原图直发）
     ├─ 无任何 image-capable 模型 → 不做处理（不注入 hint、不落盘；
     │    交给核心对图片的默认处理）
     └─ 纯文本主模型 → 解析出稳定 image_path：
        路径粘贴用源文件路径原位读用（不复制、始终取最新内容）；
        剪贴板位图落盘到用户级 vision 存储
        （<sha256>.<ext>；位于 <cache>/opencode-vision-analyze/vision）
        并注入 synthetic 提示（TUI 隐藏、模型可见）：
        "用 vision_analyze 工具查看，image_path: ..."

主模型处理：
 ├─ 有视觉：直接看原图（零成本）
 └─ 无视觉：看到提示，调用 vision_analyze(image_path, question)

vision_analyze 工具：
 ├─ 原生快速路径：会话主模型有视觉能力
 │    → 原图作为附件直接返回（不调视觉模型）
 ├─ http(s) 图片 URL → 下载（20 MB 上限）→ 统一磁盘路径
 ├─ 描述缓存命中（图片哈希 + 生效问题）→ 直接返回缓存文本
 │    （泛解析收敛到 <sha>:<固定整图描述文案>；
 │      持久化于 <cache>/opencode-vision-analyze/descriptions，
 │      标签沿用产出该描述的模型）
 └─ 候选链：沿链逐候选建子会话（parentID 挂当前会话、禁用全部工具、
     专用 system prompt，图片 + 问题发给该候选视觉模型）
     → 首个成功即返回 → 子会话删除
```

关键行为：

- **能力门控** —— 查询 `config.providers()` 能力字段，进程级缓存；有视觉能力的主模型永远不会收到提示或被路由。
- **候选链** —— `models` 列表按序逐个尝试直到成功。显式模型恒在链首；无显式配置（或 `models` 为空数组）时自动发现全部 image-capable 模型，按 provider 来源排序（config 最前 → env/api → custom/匿名；`free_first: true` 时反转）。`unlisted_fallback: true` 时显式链耗尽后会续试未列出的 image-capable 模型。
- **递归防护（整链）** —— 候选链子会话发起的消息不会被再次处理。
- **空链降级** —— 完全没有可用视觉模型时插件仍正常加载：贴图保持原样（不注入 hint），工具返回清晰错误而非路由。
- **免登录免费模型** —— 自动发现与 `/models` 选择器同源（`config.providers()`），免登录也可发现的 zen free 视觉模型会进入候选链（其 provider 为 `custom` 源 → 默认最末档；`free_first: true` 可提到最前）。
- **工具永不抛错** —— 所有失败都返回可读文字，agent 循环可以重试、换问题或告知用户。
- **URL 图片** —— `image_path` 接受 `http(s)://...` 地址（需以受支持的图片扩展名结尾：png/jpg/jpeg/gif/webp）。
- **泛解析共享同一条缓存** —— 空 / 省略的 `question` 视为整图描述，复用该图已缓存的描述；具体追问各自保留条目（细节见「存储与缓存」）。

## Roadmap

- [ ] 区域裁剪（放大查看图片细节）

## 开发

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # 单元测试（stub client，无需 opencode 实例）
bun run build       # tsc → dist/
```

单元测试使用 stub 的插件输入/client——不需要运行中的 opencode。

## 发布

版本变更完全由 `npm version` 驱动——无需手改 `package.json`。它会更新版本号、创建 commit 与 annotated `v<版本>` tag，并通过钩子先跑本地门禁再自动推送，触发 GitHub release workflow 发布到 npm。

```bash
npm version patch                      # 0.1.x → 0.1.(x+1)：commit + tag v0.1.x，自动推送 → 发布
npm version 1.2.0                      # 显式指定完整版本
npm version prerelease --preid beta    # beta 冒烟：0.1.1 → 0.1.2-beta.0
```

`package.json` 中配置的钩子：

- `preversion` —— 本地执行 `typecheck && test && build`；任一失败则不 bump / 不打 tag。
- `postversion` —— `git push --follow-tags`；推送 commit 及其 tag，触发 GitHub Actions `release.yml`（`on.push.tags: ["v*"]`），先复跑全部检查再用 `NPM_TOKEN` secret 执行 `npm publish --access public`。

beta 冒烟 → 正式两段式：

```bash
npm version prerelease --preid beta   # 先发一个 beta 到 npm
# 在 npm 上验证 beta 无误后：
npm version patch                      # 去掉 pre 段并升到正式版本
```

逃逸舱：`npm version 1.2.3 --no-git-tag-version`（只改版本文件）或 `--ignore-scripts`（跳过全部钩子）。`npm version` 要求工作区干净；若 `postversion` 推送失败，手动执行 `git push --follow-tags`。

## 许可证

[MIT](./LICENSE)
