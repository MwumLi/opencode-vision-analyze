# 图片缓存收敛为恒用户级目录 + LRU / 容量上限 设计

> 状态：定稿（2026-09-09，用户 review 通过后实现）。
> 关联实现文件：`src/index.ts`、`test/plugin.test.ts`、`test/helpers.ts`
> 关联文档：`README.md`、`README.zh.md`、`.gitignore`
> supersede：本档**替换** `docs/superpowers/specs/2026-09-08-git-scoped-image-store-design.md` 的
> 存储语义（图片存储不再按 git 分域）；旧档属历史存档只读，仅作链接引用。

## 背景与动机

2026-09-08 的 git-scoped 决策把图片存储按 git 分域（git 项目内 → `<项目>/.opencode/vision`，
非 git → 用户缓存）。review 后用户判定：

1. **项目级图片缓存没有独立价值**：除「让用户感知这个项目用过哪些图」外无其它作用，
   反而要承担 `.gitignore` 说明与「项目目录被写入运行时产物」的认知负担；且与描述缓存
   （恒用户级共享目录）在逻辑上不一致——两套缓存同属插件运行时产物，分域口径应统一。
2. **图片消费本进程内完成**：磁盘读 → base64 data URL → 子会话/附件，全部在本进程；
   图片放用户级共享目录不存在跨主机可见性问题，与 git 项目解耦反而更简单、可跨项目复用。

因此本设计：**图片缓存恒落用户级目录**（与描述缓存并列），并**顺带引入图片 LRU / 容量上限**
（原先图片存储无上限，属已知限制；本次一并受控）。

## 决策

| 决策项 | 结论 |
|---|---|
| 图片存储根 | **恒用户级**：`<cache>/opencode-vision-analyze/vision`，由 `userVisionCacheRoot(env, platform, home)` 解析（与 `resolveDescriptionDir` 对称）。**删除** `isInsideGitRepo` / `resolveVisionDir`（git 语义不再参与图片落盘）。三平台 cache 根判定与空串 env 处理沿用 `userCacheRootBase` |
| 目录结构 | 用户缓存根下两个并列子目录：`vision/`（图片字节）+ `descriptions/`（描述文本）。两套缓存同为「磁盘即事实、用户级共享、LRU + 容量上限」 |
| 图片容量默认 | `export const visionCacheLimits = { maxEntries: 2000, maxBytes: 500MB }`（模块级可变对象，测试注入小值，与 `descriptionCacheLimits` / `providersTimeout` 同风格）。单图下载上限 20MB，500MB 总量对多数用户无感 |
| LRU 时钟 | 文件 mtime：写入即新 mtime；**读取命中缓存内文件时 touch**（`utimes` 置 now）。淘汰按 mtime 升序删最旧直至双条件满足 |
| touch 范围 | **仅 touch 位于本插件 vision 缓存根内的文件**（路径前缀判定）；流程 B（模型直读外部本地文件）绝不触碰用户文件——插件不得改写外部文件 mtime |
| 淘汰触发 | **写后触发**（与描述缓存一致）：`persistImageBytes` rename 成功后对该目录跑一次淘汰，刚写入文件以 `protectName` 受保护 |
| 单图超限策略 | **允许写 + protect 当次**（与描述缓存 A/硬上限不同）：贴图/下载必须给模型稳定 image_path，不能拒绝落盘；单条 > maxBytes 时写盘但**不自我删除**，容量可短暂超限，待下一次其它写入触发淘汰时收敛（best-effort，同 spec「极端并发」条款口径） |
| 通用淘汰 | 抽 `evictToCaps(dir, limits, { filter, protectName })` 供描述/图片两缓存复用（描述过滤 `.json`；图片过滤非支持扩展名、跳过 `.tmp-*`） |
| 并发安全 | 沿用 tmp+rename 原子写（`<name>.tmp-<uuid>` → rename）；多条目独立文件，多进程并发写同 sha 原子幂等；淘汰 best-effort（unlink ENOENT 忽略） |
| 失败语义 | 全链路 fail-open：读失败/touch 失败/写失败/淘汰失败 → 静默忽略，工具永不因此抛错 |
| 不新增配置面 | 无 `cache_*` 选项 / env / 开关；默认值硬编码于模块级常量 |

## 非目标

- 不做图片与描述缓存的联动（删图不清描述、删描述不清图；图片被淘汰后旧 hint 绝对路径 stale，
  重贴即可——维持既有已知限制口径）。
- 不做迁移：历史 git 项目 `.opencode/vision` 下的旧文件不自动搬移（README 注明即可）。
- 不引入跨进程强一致（磁盘即事实，最终一致足够）。
- 主模型视觉快速路径（原图直发、不落盘）行为不变。

## 详细行为

### 目录解析（纯函数，可注入）
```
userCacheRootBase(env, platform, home):   // 既有，不变
  base = 平台 cache 根（darwin/win32/其它 + XDG_CACHE_HOME/LOCALAPPDATA 覆盖，空串视为未设置）
  → join(base, "opencode-vision-analyze")

userVisionCacheRoot(env, platform, home): // 既有，成为图片唯一存储根
  → join(userCacheRootBase(...), "vision")

resolveDescriptionDir(env, platform, home): // 既有，不变
  → join(userCacheRootBase(...), "descriptions")
```
不再需要 `isInsideGitRepo` 与 `resolveVisionDir(inputDir, …)`：图片落盘与 git 判定解耦。

### 落盘写入（下载 / 贴图统一收敛到 `persistImageBytes`，不变式仅目录来源变化）
- 计算 `sha256`；目标 `<cache>/…/vision/<sha><ext>`。
- 每次落盘现算存储根（纯函数，无 git 依赖）；写入 `<sha><ext>.tmp-<uuid>` → rename。
- rename 成功后触发 `evictToCaps(dir, visionCacheLimits, { filter: 图片, protectName: <刚写入文件> })`。
- 写/rename/淘汰失败：清理临时文件后按调用方语义返回（贴图 fail-open 返回 undefined 跳过；
  下载返回错误文字）。

### 读取 + LRU touch
- `loadImage(filepath)`：按扩展名识别 MIME 读盘。成功后**若 filepath 位于当前 vision 缓存根
  （`path.relative(visionRoot, filepath)` 不以 `..` 开头）→ `fs.utimes` touch（best-effort）**；
  否则（外部本地文件，流程 B）不 touch。

### 通用淘汰（描述/图片复用）
```
evictToCaps(dir, { maxEntries, maxBytes }, { filter, protectName }):
  names = readdir(dir).filter(filter)
  stats = names.map(stat)      // size + mtimeMs；stat 失败条目跳过
  total = Σ size; count = stats.length
  sort by mtimeMs asc, 平局按 name
  for entry in stats:
    if total <= maxBytes && count <= maxEntries → break
    if entry.name === protectName → continue
    unlink(entry) best-effort; total -= size; count -= 1
  catch → 忽略（淘汰 best-effort，下次写入再触发）
```

### 模块级可注入常量（测试用）
```
export const descriptionCacheLimits = { maxEntries: 2000, maxBytes: 50 * 1024 * 1024 }  // 既有
export const visionCacheLimits      = { maxEntries: 2000, maxBytes: 500 * 1024 * 1024 } // 新增
```
测试前后改小并在 finally 还原。

## 运行影响

- git 项目内不再写入 `<项目>/.opencode/vision` → 无 gitignore 负担；同一用户所有项目共享
  `<cache>/…/vision`，内容寻址天然跨项目去重（MB 级图片可复用）。
- 图片缓存与描述缓存目录语义统一（用户级共享、LRU + 容量受控）。
- 图片 LRU 受 maxEntries / maxBytes 约束；500MB / 2000 条对多数用户绰绰有余。

## 测试计划（TDD 先行）

helpers：
- `makeTempDir()` **去掉自动创建 `.git`**（git 语义不再参与图片落盘）。

plugin.test：
1. `userVisionCacheRoot`（纯函数注入）：Linux/macOS/Windows 默认与 XDG_CACHE_HOME / LOCALAPPDATA 覆盖、
   空串 env 回退——镜像描述缓存目录的单测。
2. 端到端（git 目录 = 带 `.git` 的临时目录）：贴图落在用户级 `vision` 目录、hint 指向该处；
   **项目目录下无 `.opencode` 产物（零污染）**。
3. 并发写同 sha：两次并发写同一 sha → 最终文件完整、无 `.tmp-*` 残留（目标用户级目录）。
4. 落盘失败路径：清理孤儿临时文件、fail-open 不注入 hint。
5. LRU 淘汰（条数）：注入 `visionCacheLimits.maxEntries = 2` → 连续贴 3 张不同图 → 最旧文件被删、目录剩 2。
6. 字节上限淘汰：注入小 maxBytes → 大图超限，最旧条目被淘汰；淘汰后 total ≤ maxBytes 且 count ≤ maxEntries。
7. 单图超限：单图 > maxBytes → **仍落盘**（稳定路径必需），且当次不被自己的淘汰删除；
   下一次其它写入触发淘汰时才可能被收敛。
8. LRU touch（缓存内）：命中缓存内文件 touch mtime；旧文件 touch 后延寿（判别用例）。
9. LRU touch（外部不碰）：流程 B 直读 vision 缓存根之外的本地文件 → 该文件 mtime 不变。
10. 既有用例零 diff：快速路径 / URL 下载 / fallback / 空链 / 能力缓存 / chat.message 门控 / 描述缓存全量。

## 文档更新

- README.md / README.zh.md：
  - 图片存储段：恒用户级 `<cache>/opencode-vision-analyze/vision`（去掉 git 分域与 `.gitignore` 建议）；
    `image_path` 本地绝对路径直接读用（不复制）；仅 http(s) URL 下载才写缓存。
  - 特性「内容寻址缓存」段：图片 + 描述两套缓存均用户级、均 LRU 受控（图片 2000 条 / 500MB，
    描述 2000 条 / 50MB）。
  - 原理图 / 已知限制同步。
- `.gitignore`：删除 `.opencode/vision/` 条目（插件不再写入该路径）。
- 历史 spec（git-scoped 等）只读存档不回改；本行为以本文档为契约。

## 验证门禁

```
bun run typecheck && bun test && bun run build
```
全绿为准；既有用例零 diff（除图片存储分域块被本 spec 语义替换外）。
