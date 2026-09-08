# 计划：能力查询超时与子会话 abort（R1/R2）

> 分支：`feat/provider-timeout-and-abort`（feature 分支开发，完成后合并）
> spec：`docs/superpowers/specs/2026-09-08-provider-timeout-and-abort-design.md`
> 门禁（每步）：`bun run typecheck && bun test && bun run build`
> 提交粒度：**每个需求单独 commit**，每个 commit 前本地门禁全绿。

## Task 1 · spec + plan 落盘

- [x] 写 `docs/superpowers/specs/2026-09-08-provider-timeout-and-abort-design.md`
- [x] 写 `docs/superpowers/plans/2026-09-08-provider-timeout-and-abort.md`
- 说明：文档随实现一并合入；先落盘供实现对照。

## Task 2 · Commit 1 — R1：`config.providers()` 查询超时

helpers 先行（红）：

- [ ] `test/helpers.ts`：暂不涉及 R1（providers 挂起注入复用既有 `setProvidersResult(() => new Promise(()=>{}))`）。
- [ ] `test/plugin.test.ts` 新增用例（红）：
  - providers 永不 resolve + `providersTimeout.ms` 调小（25ms）→ chat.message（auto 模式带图）不 stall、
    不注入 hint、`calls.providers === 1`；第二次同消息 providers 仍 1（memoize 空链）；finally 还原 ms。

实现（绿）：

- [ ] `src/index.ts`：
  - 模块级：`DeadlineError` 内部类（name="DeadlineError"）+ `export const providersTimeout = { ms: 5000 }`
  - 闭包内：`withTimeout<T>(promise, ms, timeoutMessage)`（race + timer，finally 清 timer）
  - `imageSupport` / `listImageCapableModels` 的 providers() 调用包 `withTimeout(…, providersTimeout.ms, …)`

验收：新用例绿；全量测试绿；typecheck/build 过。
commit：`feat: timeout-wrap config.providers capability query`

## Task 3 · Commit 2 — R2：超时/中止先 abort 子会话再 delete

helpers 先行（红）：

- [ ] `test/helpers.ts`：`SessionCalls` 增 `aborted: string[]`；stub `session` 增 `abort`（记录 id，返回 `{ data: true }`）。
- [ ] `test/plugin.test.ts` 新增用例（红）：
  - 超时路径：prompt 挂起 + `timeout_ms: 10` → `calls.aborted` 含 `ses_sub_1`，且本地 order 断言 abort 先于 delete；
  - 成功路径：正常描述 → `calls.aborted` 为空；
  - 用户运行中 abort：aborted 含 id、先于 delete。

实现（绿）：

- [ ] `src/index.ts`：
  - `withDeadline` 重构为 `withTimeout(Promise.race([promise, abortGuard]), timeoutMs, …)` 组合
  - `attemptModel` 增 `endedByDeadline` 标记（catch 中 `isAbortError || isDeadlineError` 置位）；
    finally 置位时先 `session.abort`（best-effort）再 `session.delete`
  - 增 `isDeadlineError` 判别

验收：新用例绿；既有超时/中止/dispose/候选链用例零 diff；typecheck/build 过。
commit：`feat: abort sub-session before delete on timeout/abort`

## Task 4 · Commit 3 — README 收尾

- [ ] `README.md` / `README.zh.md`：
  - Roadmap 移除 R1、R2（已完成）、R4（评审不做）；R5 保留未勾
  - 已知限制：能力查询无超时 → 已加 5s 超时；孤儿回合计费 → 超时/中止路径先 abort 再删（措辞收敛为残余边界）
  - （若 spec 中注明需补文档的行在此一并落实）

验收：文档措辞与行为一致。
commit：`docs: update roadmap and known limitations for R1/R2/R4`

## Task 5 · 终验与交付

- [ ] `bun run typecheck && bun test && bun run build` 全绿
- [ ] `git log` 确认三个独立 commit、工作区干净
- [ ] 交付 review（不自行 push / merge / 发版）
