# 多视觉模型候选链（fallback chain）设计

> 状态：定稿（2026-09-07，实现完成并经议会验收）。
> 关联实现文件：`src/index.ts`、`test/plugin.test.ts`、`test/helpers.ts`
> 关联文档：`docs/DESIGN.md`、`README.md`、`README.zh.md`

## 背景与目标

当前插件只接受单一必填 `model` 选项：描述失败即返回错误文字，无任何备选链（对应 README 已知限制「单模型无备选链」）。

本设计将视觉模型选择重构为「**归一化候选数组 + 单一链式尝试路径**」，新增三类能力：

1. 支持有序配置多个视觉模型，逐个尝试，成功即止，全部失败则聚合报错。
2. `unlisted_fallback` 开关：显式配置耗尽后，自动续接未列入清单的 image-capable 模型。
3. `model` 不再必填：无显式配置时默认自动尝试全部 image-capable 模型。

## 核心架构

**一切配置形态先归一化为一个有序 `chain` 数组；运行时只有一条链式循环，不感知任何开关分支。** 无论配置来源是 `model`、`models` 还是缺省，都统一构造出一个 `models` 数组，再统一走链式尝试。

`unlisted_fallback` 是**纯构建期开关**，只参与最终 `chain` 数组的组成（在 `resolveChain()` 内消费）；链一旦定型，执行逻辑只需「一个接一个尝试直到成功或耗尽」。

## 设计决策

| 决策项 | 结论 |
|---|---|
| 选项兼容 | 保留 `model`（单字符串，等价 `models: ["x"]`）；新增 `models`（有序数组）；二者并存报错 |
| 默认行为 | `model`/`models` 均缺 → 自动模式：`chain = 全部 image-capable 模型`（忽略 `unlisted_fallback`，等效默认生效） |
| 显式 + fallback | `explicit 非空 && unlisted_fallback = true` → `chain = explicit ++ (inventory − explicit)` |
| 显式 + 无 fallback | `chain = explicit`（默认 `unlisted_fallback = false`） |
| 运行时 | 单一路径 `describeWithChain(chain, ...)`，逐候选 `attempt()`；任何失败推进、abort 中止整链、全败聚合成错误 |
| 超时语义 | `timeout_ms` 改为「单候选尝试」预算（总最坏耗时 = N × timeout_ms） |
| 空链 | 显式 + 自动均无 image-capable → 插件正常加载；工具返回友好错误；chat.message 不注入 hint |
| 递归防护 | 防护集 = `chain` 全体成员 |
| 描述缓存 | 值从 `text` 改为 `{ modelId, text }`；命中标签用入库时的模型，保证真实 |
| 候选来源 | `config.providers()`，取 `models[id].capabilities.input.image === true`；复用现有 imageCapable 缓存 |
| 发现排序 | inventory 按 `Provider.source` 分档（稳定排序，档内保持 `config.providers()` 返回顺序；source 缺失/未知归档3）：默认 `config > env/api > custom`；`free_first=true` 时档序整体反转 `custom > env/api > config` |
| 免登录可用性 | `config.providers()` 与 `/models` 选择器同源：免登录时可见/可用的 zen free 模型同样会被自动发现（见「补充说明」） |

## 选项解析与校验（加载期，抛错即拒载）

```
输入:
  model?: string
  models?: string[]
  unlisted_fallback?: boolean
  free_first?: boolean          // 发现排序方向：false=config 优先（默认）；true=匿名/内置（custom）优先
  timeout_ms?: number

校验:
  model 与 models 并存                      → Error（冲突）
  model 给定但非法 provider/model 格式       → Error
  models 中任一元素非法格式                  → Error（报错信息含元素下标）
  model 与 models 均缺                      → explicit = []（合法，进入自动模式）
  unlisted_fallback 非 boolean              → 忽略并按 false 处理（与现有 timeout_ms 的宽容校验一致）
  free_first 非 boolean                     → 忽略并按 false 处理（同前）
```

`model` 由必填改为可选。

## 候选链构建 `resolveChain()`（懒加载 + memoize）

```
explicit  = normalize(model | models)          // 保序去重（重复模型只保留首个）
inventory = await listImageCapableModels()     // providers 遍历，image === true，按「发现排序」规则有序
chain =
  explicit 为空             → inventory
  explicit 非空 && fallback  → explicit ++ (inventory − explicit)
  explicit 非空 && !fallback → explicit
```

「发现排序」规则（决定 inventory 顺序）：

- 遍历 `config.providers().providers`，为每个 image-capable 模型记录所属 provider 的 `source`。
- source 分档：档1 = `config`；档2 = `env` | `api`；档3 = `custom`（`source` 缺失或为未知值一律归档3）。
- 稳定排序（档内保持 `config.providers()` 返回顺序，同一 provider 内保持模型返回顺序）：
  - 默认：档序 `config > env/api > custom`；
  - `free_first: true`：档序整体反转 `custom > env/api > config`（匿名/内置免费优先，不读 cost）。
- 排序只影响自动/fallback 部分；显式 `model`/`models` 恒在链首，不受 `free_first`/档序影响。

- memoize 为进程级 Promise（chat.message 钩子与 vision_analyze 工具共享一次查询）。
- inventory 查询同时预填 `imageCapable` 缓存，与现有 `imageSupport()` 同源，避免重复请求。
- providers 查询瞬时失败：显式链仍可用（fallback 的追加部分静默跳过）；自动模式退化为空链（按空链降级）。

## Provider.source 档位说明

`config.providers()` 返回的每个 `Provider` 带 `source: "env" | "config" | "custom" | "api"`（opencode `provider.ts` 的 `Info.source`），语义与档位对应：

| source | 含义 | 示例 | 档位 |
|---|---|---|---|
| `config` | 在 opencode.json `provider` 段显式定义 | `QAX-Codegen`、`ZJZ_Claude` | 档1 |
| `env` | 环境变量有该 provider 的 API key，启动自动发现 | `export OPENAI_API_KEY=...` | 档2 |
| `api` | 通过 `opencode auth` / `/connect` 存储的凭据 | `auth login --provider zen` | 档2 |
| `custom` | 内置匿名 / models.dev 目录默认 / 插件自动加载 | 免登录的 zen free | 档3 |

档序只在 inventory（自动/fallback 部分）内生效；显式 `model`/`models` 恒在链首。`source` 缺失或为未知值归档3（最保守，不抢占前面档位）。

## 补充说明：免登录的 zen free 视觉模型

日常使用 opencode **未配置任何登录**时，`/models` 仍可选并可使用 opencode free 模型。机制与对自动发现的影响如下：

- **目录公开**：`https://opencode.ai/zen/v1/models` 无需密钥即可读取。
- **免费层匿名调用**：请求不带 `Authorization`（或空 `Bearer `）即可访问 zen 的 zero-cost 模型；非空无效 token 反被 `401` 拒，付费模型匿名调用同样 `401`。
- **opencode 内置 provider**：opencode 自动注册 `opencode` provider，客户端带上 `x-opencode-client` 等标识头即可免密钥使用 free 模型（有 IP 级限额）；「free」在运行时的真实语义是**结构性零成本且匿名可用**（官方 `--model free` 即按 `providerID === opencode && 所有 cost 维度 === 0` 筛选，不靠名字后缀）。
- **关键不变量**：`config.providers()` 与 `/models` 选择器同源。因此「免登录能在 `/models` 里选的模型」= 自动发现能拿到的模型。
- **对候选链的影响**：自动模式 / `unlisted_fallback` 会纳入免登录可用的 image-capable free 模型（models.dev 实测，ID 前缀 `opencode/`）：
  - 支持 image 输入：`mimo-v2.5-free`、`muse-spark-1.3-contributor-free`、`muse-spark-1.2-contributor-free`、`kimi-k2.5-free`、`qwen3.6-plus-free`、`minimax-m3-free`、`x-preview-f-free` 等；
  - 纯文本 free（`deepseek-v4-flash-free`、`big-pickle`、`ling-*` 等）被 image 能力过滤，不会进入候选链。
- **排序定位**：未在 opencode.json 显式定义时，zen provider 的 source 为 `custom` → 默认档3（在 config/env/api 模型之后才轮到）；`free_first: true` 时档序反转，前置到档1。若用户在 opencode.json 显式写了 `opencode` provider 块，则其 source 为 `config`，默认即升到档1。
- **付费模型边界**：未登录时若 provider/模型不出现 → 自动模式不含它；若出现但调用 `401` → 对应候选失败，按「任何失败都推进 / 全败聚合」的既定语义处理。
- **前提仍是运行时可见性**：能力是否成立以 opencode 实际下发的 `capabilities.input.image` 为准；本插件不猜、不强开。若某模型元数据未标 image 但实际可收图，写入显式 `models` 即可绕过自动过滤。

## 行为矩阵

| 配置 | `unlisted_fallback` | `chain` 组成 |
|---|---|---|
| 无 `model`/`models` | 忽略（无效） | 全部 image-capable 模型（自动，档序见上） |
| `models: [A, B]` | `false`（默认） | `[A, B]` |
| `models: [A, B]` | `true` | `[A, B] ++ (inventory − {A, B})` |
| `model: A` | `true` | `[A] ++ (inventory − {A})` |
| `model: A` | `false` | `[A]`（长度 1，仍走统一链式路径） |

inventory 排序：默认档序 `config > env/api > custom`；`free_first: true` 时反转 `custom > env/api > config`。两表正交：`free_first` 只改 inventory 内相对顺序，不改 chain 的组成规则。

## 描述链路（唯一路径）

```
visionAnalyze(image_path, question)
  ├─ http(s) URL → 下载（逻辑不变）
  ├─ loadImage（逻辑不变）
  ├─ 快速路径：会话主模型有视觉 → 回传原图附件（逻辑不变）
  ├─ 缓存命中（key = sha256:question）→ 用缓存 { modelId, text } 打标签返回
  ├─ chain 为空 → 返回友好错误，不建子会话
  └─ describeWithChain(chain, ...)：
       for candidate of chain:
         attempt(candidate):
           create 子会话（parentID 挂当前会话）
           → prompt(该候选模型 + 图片 + 问题)
           → 提取文本 → finally delete 子会话
           成功 → 返回 { text, modelId }（写缓存）
           失败 → 记录 `${providerID}/${modelID}: <reason>`，继续下一个
         abort 事件或 pre-aborted → 立即中止整链，不推进后续候选
       全败 → 聚合错误（见下）
```

聚合错误文案建议：

```
Image analysis failed: all N candidate model(s) failed: a/b: <reason>; c/d: <reason>
```

## chat.message 钩子调整

```
1. 记录会话当前模型（不变）
2. 无 image part → 返回
3. await resolveChain()（memoized，成本一次 providers 查询）
4. 递归防护：hookInput.model ∈ chain → 返回（防护集从单模型改为 chain 全体）
5. 能力门控：会话主模型 image-capable → 返回（不变）
6. chain 为空 → 返回（不注入 hint，交给核心 unsupportedParts 默认降级）
7. 逐图落盘 + 注入 synthetic hint（不变）
```

## 错误处理原则（沿用 + 补充）

- 工具永不抛错：全败返回聚合可读文字。
- abort 不推进：pre-aborted 立即返回 `Aborted`；运行中收到 abort 即停整链（按现有 `withDeadline` 产生的 `AbortError` 判别）。
- 空链工具文案建议：

```
Image analysis failed: no image-capable model configured (set the plugin model/models option or configure an image-capable provider model)
```

- 子会话仍逐候选「用后即删」，`dispose` 兜底清理残留（不变）。

## 测试计划（TDD 先行）

helpers.ts 调整：

- `setPromptBehavior` 改签名接收 `body.model`，支持按模型定制成败 / 挂起（向后兼容无参行为）。
- providersResult 支持多 provider、多模型的 image 能力组合；每个 provider 携带 `source`（`config` / `env` / `api` / `custom`），模型可带 `cost`（供 free_first 语义后续扩展，当前按 source 判定）。

plugin.test.ts 新增：

1. 选项校验：`model` + `models` 冲突抛错；models 非法元素抛错；均缺合法加载（自动模式）。
2. 显式有序链：A 失败 → B 成功；prompt 调用顺序 `[A, B]`；输出标签为 B。
3. 全败聚合：两候选均失败 → 输出含两候选及各自原因，不抛错。
4. abort：候选 A 挂起中 abort → 不再尝试 B（prompt 调用仅 A 一次），输出 Aborted。
5. `unlisted_fallback = false`：显式 `[A]` 失败 → 不尝试未列出的 image-capable C。
6. `unlisted_fallback = true`：显式 `[A]` 失败 → 续试未列出的 C 并成功，标签 C。
7. 自动模式（无配置）：chain = 全部 image-capable（text-model 被排除）；走首个 image-capable。
8. 空链降级：providers 无 image-capable → 工具友好错误、不建子会话、chat.message 不注入 hint。
9. 递归防护：消息模型 = chain 中非首候选 → 不处理。
10. 缓存标签：A 产出的缓存命中时标签仍为 A（不误标成当前链首模型）。
11. 自动模式排序（默认档序）：providers 含 config 源 image 模型与 custom 源 image 模型（zen free）→ config 源先被尝试。
12. `free_first = true`：同样 providers 场景下 custom 源（zen free）image 模型先于 config 源被尝试。
13. 未知/缺失 source 归档3：与 custom 源同档，按 `config.providers()` 返回顺序排在该档内；无更高档视觉模型时该档模型可被使用/续试。

## 文档更新

- README.md / README.zh.md：选项表新增 `models`、`unlisted_fallback`、`free_first`；`model` 标为可选；移除「单模型无备选链」限制；补充候选链示例、发现排序（source 档序）与 zen free 免登录说明。
- docs/DESIGN.md：新增决策行（候选链归一化 / 单一路径 / fallback 构建期语义 / 发现排序按 Provider.source / free_first 反转档序 / 缓存记录 modelId / 空链降级）。

## 验证门禁

```
bun run typecheck && bun test && bun run build
```

全绿为准。
