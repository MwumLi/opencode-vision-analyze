# 描述缓存按内容 sha 落盘持久化（含 LRU / 容量上限）设计

> 状态：定稿（2026-09-08，用户 review 通过）。
> 关联实现文件：`src/index.ts`、`test/plugin.test.ts`
> 关联文档：`README.md`、`README.zh.md`、`docs/superpowers/specs/2026-09-05-opencode-vision-analyze-design.md`
> 决策依据（生态调研）：opencode 视觉插件（showlotus/opencode-image-vision、JochenYang/opencode-vision、
> martinmose/opencode-vision-bridge 等）普遍把图片放 OS temp / 用户级 cache 目录而非 git 项目内，描述缓存多为
> 进程内 LRU 或不做磁盘持久化；hermes-agent 将图片/下载件放用户级 `cache` 目录。本项目描述缓存落盘属超出生态
> 的增强，但方向一致（用户级共享、内容寻址、LRU 受控）。

## 背景与动机

现状（src/index.ts:497-509）：描述缓存在**进程内存 Map** 中，key = `<图片sha256>:<问题>`，值 `{ modelId, text }`。
问题：

1. 缓存生命周期 = 进程生命周期：插件/opencode 重启即全部丢失。
2. 跨项目/跨进程不共享：同一张图 + 同一问题在另一项目、另一进程、隔天会话都要重新付费描述一次。
3. 进程内 Map 无上限，按 (图, 问题) 对数增长（README 已知限制「缓存无上限」）。

Roadmap 项：**描述缓存按内容 sha 落盘持久化（含 LRU / 容量上限）**。图片字节已按 `<sha256>.<ext>` 内容寻址
落盘（git 分域，另见 git-scoped spec），描述缓存是「还没落盘」的那一半。

## 决策

| 决策项 | 结论 |
|---|---|
| 范围 | 仅描述缓存落盘；图片存储分域（git → 项目 / 非 git → 用户缓存）**不动**，维持 git-scoped spec 决策 |
| 存储作用域 | **用户级共享**：`<cache>/opencode-vision-analyze/descriptions`。三平台 cache 根判定与空串 env 处理复用 `userVisionCacheRoot` 的平台逻辑，但**恒定用户级、不随 git 分域**（描述键与项目无关，跨项目共享是价值所在） |
| 缓存 key | `<imageSha256>:<question>`（沿用现状，语义不变） |
| 条目文件 | 每条目一个 JSON 文件 `<dir>/<sha256(fullKey)>.json`，内容 `{ modelId, text }`。用 fullKey 的 sha256 作文件名：定长、免转义（key 含 `:`/长 question/任意字符） |
| LRU 时钟 | **文件 mtime**：写入即新 mtime；命中 `utimes` touch（置 now）。淘汰按 mtime 升序删最旧 |
| 引擎形态 | **磁盘即事实**：不加载全量索引、无进程内存镜像。命中 miss 先 `readFile` 探存在；写直写文件 + 触发淘汰；淘汰 `readdir`+`stat` 排序删最旧。跨进程实时可见，零状态同步 |
| 容量上限 | 硬编码 `maxEntries = 2000` 条 + `maxBytes = 50MB`（条目文件字节和），任一超限即淘汰 LRU 直至双条件满足；**不新增配置面**。做成模块级可变对象（`export const descriptionCacheLimits = { maxEntries, maxBytes }`）供测试注入小值（与 `providersTimeout` 同风格） |
| 并发安全 | 复用图片落盘的 tmp+rename 原子写（`<name>.tmp-<uuid>` → rename）；每条目独立文件，多进程并发写同 key 原子幂等；淘汰 best-effort（readdir 快照可能含已被他进程删的文件，unlink 失败忽略） |
| 失败语义 | 全链路 fail-open：读失败 / JSON 损坏 / shape 非法 / 文件消失 → miss（正常走链重算，重算后再写）；写失败 / tmp 清理失败 / touch 失败 / 淘汰 unlink 失败 → 静默忽略；工具永不因缓存而抛错 |
| 命中标签 | 沿用入库 modelId（缓存值与磁盘语义一致），不随候选链链首重写 |
| 单文件约束 | 保持 `src/index.ts` 单文件（curl 单文件分发、零依赖），逻辑收敛为闭包内 helper，不拆模块 |

## 非目标

- 图片存储不动（git 分域维持现状）；不做图片 LRU（独立项，另议）。
- 不新增 `cache_*` 配置项 / env / 开关。
- 不做进程内存镜像、不做跨进程强一致（磁盘即事实，最终一致足够）。
- 不自动迁移（本就没有旧持久化文件）；不做缓存条目间的删除联动（删图片不清对应描述缓存）。

## 详细行为

### 目录解析（纯函数，可注入 env/platform/homedir）
```
resolveDescriptionDir(env, platform, home):
  base = 平台 cache 根（与 userVisionCacheRoot 相同判定：
         darwin → XDG_CACHE_HOME || ~/Library/Caches
         win32  → LOCALAPPDATA || ~/AppData/Local
         其它   → XDG_CACHE_HOME || ~/.cache
         空串 env 视为未设置)
  → join(base, "opencode-vision-analyze", "descriptions")
```
不依赖 `input.directory` / git 判定 → 同一用户所有项目共享一份描述缓存。

### 文件命名
```
key    = `${sha256(imageBytes)}:${question}`
fname  = `${sha256(key)}.json`          // hex, 64 字符
file   = join(descDir, fname)
```

### 命中查询（visionAnalyze 缓存段）
```
lookup(key):
  try readFile(file)
  if ENOENT → miss
  parse JSON；shape 须为 { modelId: string, text: string }（text 非空）
    → 命中: utimes(file, now) best-effort → 返回 { modelId, text }
  解析失败 / shape 非法 / 其它 fs 错误 → miss（不删文件，重算后由写入覆盖）
```
命中分支沿用现有：`format(basename, cached.modelId, cached.text)`，title `(cached)`。

### 写入 + 淘汰（新描述产出后）
```
store(key, { modelId, text }):
  mkdir(descDir, { recursive: true, mode: 0o700 })
  tmp = file + ".tmp-" + randomUUID()
  writeFile(tmp, JSON.stringify({ modelId, text })) → rename(tmp, file)
  catch → unlink(tmp) best-effort，忽略
  // 容量淘汰（写后触发）
  entries = readdir(descDir)（过滤 *.json，忽略 tmp）
  stats   = entries.map(stat)  // size + mtime；stat 失败条目跳过
  totalBytes = Σ size；count = stats.length
  while (totalBytes > maxBytes || count > maxEntries):
     oldest = 当前未被删的 mtime 最小文件
     if 无 → break
     unlink(oldest) best-effort；totalBytes -= size；count -= 1
```
best-effort：readdir 快照与 unlink 之间可能已被其它进程淘汰/重写 → unlink ENOENT 忽略；
极端并发下容量可能短暂超限，收敛于各进程后续写入时再淘汰（缓存非关键路径，可接受）。

### 模块级可注入常量（测试用）
```
export const descriptionCacheLimits = { maxEntries: 2000, maxBytes: 50 * 1024 * 1024 }
```
测试前后改小并在 finally 还原（与 `providersTimeout` 用法一致）。

## 运行影响

- 目录放用户级 cache：多 opencode 进程/多项目共享同一描述目录 → 同图同问题只描述一次，跨进程/重启命中。
- 磁盘占用受 maxBytes/maxEntries 双重约束；条目为文本（KBs），2000 条/50MB 对多数用户绰绰有余。
- 首次实现后旧进程内 Map 删除，`descriptions` 闭包变量移除。

## 测试计划（TDD 先行）

plugin.test 新增（描述缓存相关块 / 新 describe）：

1. `resolveDescriptionDir`（纯函数注入）：Linux/macOS/Windows 默认与 XDG_CACHE_HOME / LOCALAPPDATA 覆盖、
   空串 env 回退；**与 git/非 git 无关恒用户级**（git 项目目录同样返回用户级路径）。
2. 命中落盘：两次独立插件实例 + 共享 XDG_CACHE_HOME → 第一实例产出描述落盘，第二实例同图同问题
   **不调 prompt**（title `(cached)`，`calls.prompt` 0）→ 验证跨进程/重启持久命中。
3. 命中沿用入库 modelId 标签：磁盘文件由 other-vision 产出 → 新实例命中标签仍 `described by test/other-vision`。
4. LRU 淘汰（条数）：注入 `descriptionCacheLimits.maxEntries = 2` → 连续写入 3 个不同 key → 最旧条目文件被删、
   目录只剩 2 个。
5. 字节上限淘汰：注入小 maxBytes → 大 text 条目超限，最旧条目被淘汰。
6. 容量不超限断言：淘汰后 totalBytes ≤ maxBytes 且 count ≤ maxEntries。
7. 并发/幂等：同 key 并发两写 → 文件完整（rename 原子）、无 `.tmp-*` 孤儿（对齐图片并发写用例）。
8. 损坏容错：手写坏 JSON 到命中路径 → miss、正常调链重算；写失败（目标路径被目录占用）fail-open 不抛错。
9. 既有用例零 diff：快速路径 / URL 下载 / fallback / 空链 / 能力缓存 / chat.message 门控不变。

helpers：无需改动（`makeTempDir` 已带 `.git`；非 git 用例沿用注入 XDG_CACHE_HOME 模式）。

## 文档更新

- README.md / README.zh.md：
  - 特性「内容寻址缓存」段：描述缓存改为用户级目录持久化描述（含路径），补充 LRU 上限（2000 条 / 50MB）。
  - 原理图 vision_analyze 分支措辞同步（命中 → 磁盘缓存）。
  - 已知限制「缓存无上限」改写：图片存储仍无上限（git 分域/用户级）；描述缓存已持久化 + LRU 受控。
  - Roadmap：勾选「描述缓存按内容 sha 落盘持久化（含 LRU / 容量上限）」。
- `src/index.ts` 头部注释同步（描述缓存用户级落盘 + LRU）。
- 历史 spec（git-scoped / 2026-09-05 等）属只读存档，**不回改**；本行为以本文档为契约。

## 验证门禁

```
bun run typecheck && bun test && bun run build
```
全绿为准；既有用例零 diff。
