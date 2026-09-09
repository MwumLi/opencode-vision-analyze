# 图片缓存收敛为恒用户级目录 + LRU / 容量上限 执行计划

> 日期：2026-09-09。关联 spec：`docs/superpowers/specs/2026-09-09-vision-store-user-level-lru-design.md`
> 分支：`feat/vision-store-user-level-lru`（基于 main，合入走 PR review）
> 门禁：`bun run typecheck && bun test && bun run build`（TDD：先红测试 → 源码 → 文档）

## 任务拆解

- [x] 1. helpers 简化：`test/helpers.ts` 的 `makeTempDir()` 去掉自动创建 `.git`（git 语义不再相关）。
- [x] 2. 测试重写（红→绿）：`test/plugin.test.ts`
  - [x] 2a. import 调整：移除 `isInsideGitRepo` / `resolveVisionDir`，改引 `userVisionCacheRoot`、`visionCacheLimits`。
  - [x] 2b. `persistedPath()` 改指 `cacheHome/opencode-vision-analyze/vision/<sha>.png`。
  - [x] 2c. 负向断言（无图不建目录等）改查用户级 vision 目录。
  - [x] 2d. 整块「图片存储分域（git / 用户级）」→「图片缓存（恒用户级 + LRU/容量）」：
        `userVisionCacheRoot` 三平台/env/空串单测；git 目录贴图落用户级且项目 `.opencode` 零污染；
        并发同 sha（用户级目标）；fail-open tmp 清理；LRU 条数/字节淘汰；单图超限允许写 + 当次不被自删；
        LRU touch 缓存内延寿；touch 外部文件 mtime 不变。
- [x] 3. 源码：`src/index.ts`
  - [x] 3a. 删除 `isInsideGitRepo` / `resolveVisionDir` 导出与 `existsSync` import；顶部注释同步。
  - [x] 3b. 新增 `export const visionCacheLimits = { maxEntries: 2000, maxBytes: 500 * 1024 * 1024 }`。
  - [x] 3c. `persistImageBytes` 目录改 `userVisionCacheRoot(...)`；rename 后触发图片淘汰（protect 刚写文件）。
  - [x] 3d. 抽通用 `evictToCaps(dir, limits, { filter, protectName })`；`evictDescriptionCache` 改为其调用。
  - [x] 3e. `loadImage`：命中缓存根内文件 touch mtime；外部文件不 touch。
- [x] 4. 文档同步
  - [x] 4a. `.gitignore` 删 `.opencode/vision/` 条目。
  - [x] 4b. README.md / README.zh.md：图片存储段（恒用户级、本地路径直读、仅下载写缓存）、特性段、
        原理图、已知限制。
  - [x] 4c. spec/plan 头部勾选与本档定稿。
- [x] 5. 门禁全绿 + commit（可分逻辑 commit：test red → src → docs）。
- [x] 6. 交付 review：不自行 push / merge / 发版。

## 验收标准

- `bun run typecheck && bun test && bun run build` 全绿；测试数净增（替换分域块 + 新增 LRU/touch 用例）。
- git 项目目录贴图不再产生 `.opencode` 产物；图片落用户级 `vision/`。
- 图片缓存受 maxEntries/maxBytes 双上限约束；单图超限可短暂超限但不自删；外部文件 mtime 不被 touch。
