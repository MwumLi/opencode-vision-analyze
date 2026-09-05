# opencode-vision-analyze

[![npm](https://img.shields.io/npm/v/opencode-vision-analyze)](https://www.npmjs.com/package/opencode-vision-analyze)
[![license](https://img.shields.io/npm/l/opencode-vision-analyze)](./LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai/docs/plugins)

[English](./README.md) | 简体中文

一个面向 [opencode](https://opencode.ai) 的工具化视觉路由插件：当主模型看不了图片时，由它按需调用 `vision_analyze` 工具——你指定的视觉模型描述图片，描述文字直接回到对话中。当主模型本身支持图片时，贴图原样直发，工具短路返回原图。

**零运行时依赖。** 只用 node 内置模块（`crypto`/`fs`/`path`）和纯类型导入——除插件本身外无需安装任何东西。

## 为什么选这个

生态里已有若干视觉插件，差异如下：

| | opencode-vision | opencode-vision-router | opencode-image-vision | **opencode-vision-analyze** |
|---|---|---|---|---|
| 机制 | skill + 子代理委托 | 指针 + 子代理委托 | 直连 SDK（read-image / read-ocr） | **工具 + 插件自管子会话** |
| 视觉模型来源 | 自动发现的视觉模型 | 单一 `model` 选项 | 每功能独立 provider/model | 单一 `model` 选项 |
| 主模型能力判定 | models.dev 目录 + auth | `chat.params` 实时学习 | 名字正则（脆弱） | `config.providers()` 能力查询（缓存） |
| 图片落盘 | /tmp（会话+part 哈希） | tmpDir | 用户目录 / 剪贴板目录 | `.opencode/vision/` 内容寻址 sha256 |
| 产出 | 子代理自行作答 | 子代理自行作答 | 描述 / OCR 文本 | 描述文本（带缓存） |
| 有视觉主模型 | 跳过注册 | 跳过路由（`force` 可强制） | skipModels / forceDescription | 跳过注入 + **原生快速路径**（工具直接回传原图附件） |
| 请求路径 | opencode 会话 | opencode 会话 | **第三方 SDK 直连** | opencode 子会话（统一鉴权，无需额外密钥） |
| 失败可见性 | 经子代理工具链 | 经子代理 | 工具输出 | 工具输出（永不抛错） |

亮点：

- **工具化，而非提交时预分析。** 轮次即时启动；模型自己决定何时看图、带着什么问题看。提交零阻塞，失败在 agent 循环里可见、可重试。
- **描述针对问题。** 模型把自己关注的问题传给 `vision_analyze`——而不是提交时预生成的一次性通用描述。
- **原生快速路径。** 主模型本身有视觉能力时，`vision_analyze` 完全跳过视觉模型，直接把原图作为工具附件返回。
- **内容寻址缓存。** 图片按 `<sha256>.<ext>` 落盘（跨会话天然去重）；描述按 `<图片哈希>:<问题>` 缓存——同图同问题只描述一次。
- **统一鉴权。** 视觉调用走 opencode 子会话，复用 opencode 已管理的 provider 凭据，无需额外配置 API Key。

## 运行前提

- [opencode](https://opencode.ai)（插件由 Bun 加载；npm 插件启动时自动安装）
- 一个你可用的视觉模型，以 `provider/model` 引用（如 `"openai/gpt-4o-mini"`、`"anthropic/claude-sonnet-4-5"`）
- 受支持的图片扩展名：png / jpg / jpeg / gif / webp

## 安装

### 方式 A —— npm（推荐）

```jsonc
// opencode.json（项目级或全局）
{
  "plugin": [
    ["opencode-vision-analyze", { "model": "openai/gpt-4o-mini" }]
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
    ["./.opencode/vision-analyze.ts", { "model": "openai/gpt-4o-mini" }]
  ]
}
```

curl 方式说明：

- 建议固定到发布 tag 而非 `main`，如 `.../opencode-vision-analyze/v0.1.0/src/index.ts`；升级即重新 curl。
- 文件是 TypeScript 源码——opencode 用 Bun 加载插件，直接可用。
- 选项必须通过 `plugin` 元组传入（`.opencode/plugins/` 自动发现目录无法携带选项）。

### 选项

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `model` | 是 | — | 视觉模型，`provider/model` 格式，如 `"anthropic/claude-sonnet-4-5"`、`"openai/gpt-4o-mini"` |
| `timeout_ms` | 否 | `60000` | 视觉子会话请求超时（毫秒） |

## 工作原理

```
用户贴图 + 提问
 └─ chat.message 钩子（消息持久化前）
     ├─ 主模型支持图片输入 → 不做任何处理（原图直发）
     └─ 纯文本主模型 → 图片落盘 .opencode/vision/<sha256>.<ext>
        并注入 synthetic 提示（TUI 隐藏、模型可见）：
        "用 vision_analyze 工具查看，image_path: ..."

主模型处理：
 ├─ 有视觉：直接看原图（零成本）
 └─ 无视觉：看到提示，调用 vision_analyze(image_path, question)

vision_analyze 工具：
 ├─ 原生快速路径：会话主模型有视觉能力
 │    → 原图作为附件直接返回（不调视觉模型）
 ├─ http(s) 图片 URL → 下载（20 MB 上限）→ 统一磁盘路径
 ├─ 描述缓存命中（图片哈希 + 问题）→ 直接返回缓存文本
 └─ 子会话：parentID 挂当前会话、禁用全部工具、专用 system
     prompt，图片 + 问题发给你的视觉模型
     → 返回描述文字 → 子会话立即删除
```

关键行为：

- **能力门控** —— 查询 `config.providers()` 能力字段，进程级缓存；有视觉能力的主模型永远不会收到提示或被路由。
- **递归防护** —— 视觉模型自己的消息（来自子会话）不会被再次处理。
- **工具永不抛错** —— 所有失败都返回可读文字，agent 循环可以重试、换问题或告知用户。
- **URL 图片** —— `image_path` 接受 `http(s)://...` 地址（需以受支持的图片扩展名结尾：png/jpg/jpeg/gif/webp）。

## 已知限制

- **仅 V1 会话流** —— 钩子挂在 V1 `SessionPrompt` 路径上；若 opencode 默认交互切到 V2 会话核心，钩子不会触发（且不报错）。
- **SSRF 面** —— URL 下载跟随重定向、不拦截私网/云元数据地址。本地单用户 CLI 信任级别下可接受；多租户环境使用前应加地址过滤。
- **中止不传导** —— 用户中止不会取消进行中的下载/子会话请求，它们会跑到各自的 deadline（下载 30 秒、子会话 `timeout_ms`）。超时/中止后子会话虽被删除，但 provider 端的孤儿回合仍可能计费。
- **历史图片** —— 插件启用之前发送的图片无法被描述（无提示、磁盘上无路径）。
- **缓存无上限** —— 图片存储与描述缓存均不淘汰（进程级 / 项目目录级）。
- **单模型无备选链** —— 只有一个显式 `model` 选项；失败时返回错误文字，不会尝试其他 provider。

## Roadmap

- [ ] `model` 未显式指定时对首条消息的回退处理
- [ ] 能力查询（`config.providers()`）加超时保护
- [ ] 超时路径先中止子会话（`/session/{id}/abort`）再删除
- [ ] 描述缓存 LRU / 容量上限
- [ ] URL 下载可选私网地址拦截
- [ ] 区域裁剪（放大查看图片细节）

## 开发

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # 单元测试（stub client，无需 opencode 实例）
bun run build       # tsc → dist/
```

单元测试使用 stub 的插件输入/client——不需要运行中的 opencode。

## 许可证

[MIT](./LICENSE)
