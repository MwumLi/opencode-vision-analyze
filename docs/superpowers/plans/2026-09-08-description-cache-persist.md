# 计划：描述缓存按内容 sha 落盘持久化（含 LRU / 容量上限）

> 分支：`feat/description-cache-persist`（feature 分支开发，完成后合并）
> spec：`docs/superpowers/specs/2026-09-08-description-cache-persist-design.md`
> 门禁（每步）：`bun run typecheck && bun test && bun run build`
> 提交粒度：**每步独立 commit**，commit 前门禁全绿。

## Task 1 · spec + plan 落盘

- [ ] 写 `docs/superpowers/specs/2026-09-08-description-cache-persist-design.md`
- [ ] 写 `docs/superpowers/plans/2026-09-08-description-cache-persist.md`
- [ ] 切分支 `feat/description-cache-persist`
- [ ] commit `docs: spec & plan for persistent description cache (sha-addressed, LRU/capped)`

## Task 2 · 测试先行（红）：新增用例

- [ ] `test/plugin.test.ts` 新增（先红）：
  - `resolveDescriptionDir`：三平台 + env 覆盖 + 空串回退 + git/非 git 无关恒用户级
  - 跨实例/重启命中：两插件实例共享 XDG_CACHE_HOME → 第二实例不调 prompt
  - 命中沿用入库 modelId 标签（磁盘持久化后还原）
  - LRU 条数淘汰 / 字节上限淘汰 / 容量不超限
  - 同 key 并发两写 → 文件完整、无 `.tmp-*` 孤儿
  - 损坏 JSON → miss 重算；写失败 fail-open
- [ ] 门禁：新用例红（预期失败），既有零 diff
- commit `test: red cases for persistent description cache`

## Task 3 · 实现（绿）

- [ ] `src/index.ts`：
  - 新增 `export const descriptionCacheLimits = { maxEntries: 2000, maxBytes: 50MB }`
  - 新增纯函数 `resolveDescriptionDir(env, platform, home)`（用户级恒定，与 git 无关）
  - 移除进程内 `descriptions` Map；`visionAnalyze` 缓存段改为磁盘 lookup/store helper
  - lookup：文件名 = sha256(key).json；readFile+parse+shape 校验 → 命中 utimes touch
  - store：mkdir(0o700) + tmp+rename 原子写 → 触发容量淘汰（readdir+stat，mtime 升序删最旧）
  - 全链 fail-open（读/写/touch/淘汰错误一律吞掉不抛）
- [ ] 门禁：全绿（新用例绿 + 既有零 diff）
- commit `feat: persist description cache to user cache dir with LRU cap`

## Task 4 · README + 头部注释收尾

- [ ] `README.md` / `README.zh.md`：特性段、原理图、已知限制、Roadmap 勾选
- [ ] `src/index.ts` 头部注释同步
- [ ] 门禁：typecheck / test / build 全绿
- commit `docs: document persistent description cache (LRU/capped, user-level)`

## Task 5 · 终验与交付

- [ ] `bun run typecheck && bun test && bun run build` 全绿
- [ ] `git log` 确认提交序列与工作区干净
- [ ] 交付 review（不自行 push / merge / 发版）
