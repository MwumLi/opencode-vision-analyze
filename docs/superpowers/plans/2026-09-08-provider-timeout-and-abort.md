# 计划：能力查询超时与子会话 abort（R1/R2）

> 分支：`feat/provider-timeout-and-abort`（feature 分支开发，完成后合并）
> spec：`docs/superpowers/specs/2026-09-08-provider-timeout-and-abort-design.md`
> 门禁（每步）：`bun run typecheck && bun test && bun run build`
> 提交粒度：**每个需求单独 commit**，每个 commit 前本地门禁全绿。

## Task 1 · spec + plan 落盘

- [x] 写 `docs/superpowers/specs/2026-09-08-provider-timeout-and-abort-design.md`
- [x] 写 `docs/superpowers/plans/2026-09-08-provider-timeout-and-abort.md`
- commit `a9c2755 docs: spec & plan for provider query timeout and sub-session abort (R1/R2)`

## Task 2 · Commit 1 — R1：`config.providers()` 查询超时

- [x] `test/plugin.test.ts` 新增用例（先红）：providers 永不 resolve + `providersTimeout.ms` 调小（25ms）
  → chat.message（auto 模式带图、model 缺省）不永久 stall、不注入 hint、`calls.providers === 1`；
  第二次同消息 providers 仍 1（memoize 空链）；finally 还原 ms。
- [x] `src/index.ts`：模块级 `DeadlineError` + `export const providersTimeout = { ms: 5000 }`；
  闭包内 `withTimeout(promise, ms, message)`；`imageSupport` / `listImageCapableModels` 的
  providers() 调用包超时。
- [x] 验收：typecheck / test / build 全绿。
- commit `36237c9 feat: timeout-wrap config.providers capability query`

## Task 3 · Commit 2 — R2：超时/中止先 abort 子会话再 delete

- [x] `test/helpers.ts`：`SessionCalls` 增 `aborted: string[]`；stub `session` 增 `abort`。
- [x] `test/plugin.test.ts` 新增用例（先红）：超时路径 abort 先于 delete（本地 order 断言）；
  成功路径零 abort；既有"运行中 abort"用例补 aborted 断言。
- [x] `src/index.ts`：`withDeadline` 重构为 `withTimeout(Promise.race([promise, abortGuard]), …)` 组合；
  `attemptModel` 增 `endedByDeadline` 标记，finally 置位时先 `session.abort`（best-effort）再 delete；
  增 `isDeadlineError`。
- [x] 验收：新用例绿；既有超时/中止/dispose/候选链用例零 diff；门禁全绿。
- commit `ed3aad3 feat: abort sub-session before delete on timeout/abort`

## Task 4 · Commit 3 — README 收尾

- [x] `README.md` / `README.zh.md`：Roadmap 移除 R1、R2（已完成）与 R4（评审不做），R5 保留未勾；
  已知限制"中止不传导"改写为"中止传导不完整"（子会话先 abort 再删 + 残余边界）。
- [x] `src/index.ts` 头部注释同步更新（中止传导 + 能力查询 5s 超时）。
- commit `01def45 docs: update roadmap and known limitations for R1/R2 (R4 descoped)`

## Task 5 · 终验与交付

- [x] `bun run typecheck && bun test && bun run build` 全绿（56 pass）
- [x] `git log` 确认提交序列与工作区干净
- [x] 交付 review（不自行 push / merge / 发版）
