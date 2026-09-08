# 能力查询超时与子会话 abort（R1/R2）设计

> 状态：定稿（2026-09-08，随 feat/provider-timeout-and-abort 分支实现）。
> 范围：README Roadmap 前两项 —— ① `config.providers()` 能力查询超时保护；② 超时/中止路径先
> `session.abort` 再 delete。R4（URL 私网拦截）经评审后决定不做，已从 Roadmap 移除；R5（区域裁剪）
> 保留并另行 brainstorm。
> 关联实现文件：`src/index.ts`、`test/plugin.test.ts`、`test/helpers.ts`
> 关联文档：`docs/superpowers/specs/2026-09-05-opencode-vision-analyze-design.md`（只读存档）、
>   `README.md`、`README.zh.md`

## 背景与目标

### R1 · `config.providers()` 能力查询无超时

`imageSupport()`（src/index.ts `imageSupport`）与 `listImageCapableModels()`（src/index.ts
`listImageCapableModels`）都直接 `await input.client.config.providers()`，无任何超时保护。`resolveChain()`
把结果 memoize 为进程级 Promise（`chainPromise`）——若该请求**挂起**（网络故障、server 异常等），
Promise 永不 settle：chat.message 钩子与 vision_analyze 工具会**永久 stall**，比"查询失败返回空"
（现有已知限制已覆盖、会降级为可读错误）更糟——空结果至少让插件继续工作。

目标：能力查询加超时保护；超时按"查询失败"语义处理——返回 `false` / 空链、不写 imageCapable
缓存、不留下挂起的 memoize Promise（保住"瞬时故障可重试 / 空链可降级"的既有语义）。

### R2 · 超时/中止先 abort 子会话再 delete

`attemptModel()` 的 finally 只做 `session.delete`。当 `withDeadline` 因**本地超时**（timeout_ms 到期）
或**用户 abort** 拒绝时，底层 prompt 请求在 provider/server 端仍可能运行，直接 delete 会留下
"孤儿回合"（provider 端已发出的请求不取消、仍计费）——即 2026-09-05 spec 已知限制「孤儿回合计费」。
opencode SDK v1 已暴露 `session.abort`（`node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts`），
可在删除前先 abort 以真正取消孤儿回合。

目标：凡"回合可能仍在飞"的结束路径（超时 / 用户 abort）先 best-effort `session.abort({ path: { id } })`
再 delete；正常成功 / 普通失败路径（turn 已自然结束）不 abort。

## 设计决策

| 决策项 | 结论 |
|---|---|
| 超时原语 | 新增 `withTimeout<T>(promise, ms, timeoutMessage)`：`Promise.race` + 定时器，到期以 `DeadlineError(timeoutMessage)` 拒绝；finally 清 timer。不依赖 `ToolContext`（钩子路径无 ctx），供 R1 与 R2 的 `withDeadline` 复用 |
| 超时错误类型 | 内部类 `DeadlineError extends Error`（`name = "DeadlineError"`），与 `AbortError` 并列可判别：`isDeadlineError` / 既有 `isAbortError` 两条判别，供 R2 判定"回合是否可能在飞" |
| providers 超时预算 | 模块级 `export const providersTimeout = { ms: 5000 }`（5 秒）。做成可改写对象而非选项：避免选项膨胀，同时测试可把 `ms` 调小缩短等待（导出 let 在 TS 中不可对 import 赋值，故用对象承载） |
| R1 失败语义 | 超时在 `imageSupport` 落入既有 catch → 返回 `false`（不缓存、下次可重试）；在 `listImageCapableModels` 落入既有 catch → 记日志并返回 `[]`（空链降级；`resolveChain` memoize 空结果属既有已知限制，本次不改变——区别是从"永久挂起"变为"5s 后降级"） |
| R2 abort 时机 | `attemptModel` 引入 `endedByDeadline` 标记：catch 里 `isAbortError || isDeadlineError` 置位；finally 中若置位先 `session.abort`（best-effort，`.catch(()=>{})`）再 `session.delete`。成功路径与普通失败路径标记为 false，不 abort |
| `withDeadline` 重构 | 由"自建 timer + abort 监听"改为 `withTimeout(Promise.race([promise, abortGuard]), timeoutMs, …)` 组合，单一超时机制；超时文案不变（`vision model call timed out after ${timeoutMs}ms`），既有测试零 diff |
| dispose | 不变：孤儿清理仍只 delete（此时无法区分回合状态，abort 无依据），delete 失败静默 |

## 机制与改动点

### 新增（模块级）

```ts
class DeadlineError extends Error {          // name = "DeadlineError"
  constructor(message: string) { super(message); this.name = "DeadlineError" }
}
export const providersTimeout = { ms: 5000 } // 可改写对象（测试缩短等待）
```

### 新增（插件闭包内）

```ts
const withTimeout = async <T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(timeoutMessage)), ms)
  })
  try { return await Promise.race([promise, guard]) }
  finally { if (timer) clearTimeout(timer) }
}

const isDeadlineError = (error: unknown): boolean =>
  error instanceof Error && error.name === "DeadlineError"
```

### R1 接线

```ts
// imageSupport / listImageCapableModels 内的 providers() 调用：
const result = await withTimeout(
  input.client.config.providers(),
  providersTimeout.ms,
  `config.providers() timed out after ${providersTimeout.ms}ms`,
)
```

两处调用点在既有 try 内——超时即 DeadlineError → 被既有 catch 捕获，按查询失败处理，无需新分支。

### R2 接线（attemptModel）

```ts
let endedByDeadline = false                        // 回合可能在飞 → finally 需先 abort
try {
  const created = await withDeadline(…create…)
  …
  const response = await withDeadline(…prompt…)
  …
} catch (error) {
  endedByDeadline = isAbortError(error) || isDeadlineError(error)
  return { ok: false, error: errText(error), aborted: isAbortError(error) }
} finally {
  if (subID) {
    subSessions.delete(subID)
    if (endedByDeadline) await input.client.session.abort({ path: { id: subID } }).catch(() => {})
    await input.client.session.delete({ path: { id: subID } }).catch(() => {})
  }
}
```

注：`endedByDeadline` 在 create 阶段置位但 `subID` 尚未产生时（create 自身超时），finally 的
`if (subID)` 已排除——不会 abort 一个不存在的会话，正确。

### `withDeadline` 重构（复用 withTimeout）

```ts
const withDeadline = <T>(promise: Promise<T>, ctx: ToolContext): Promise<T> => {
  if (ctx.abort.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
  let onAbort: (() => void) | undefined
  const abortGuard = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    ctx.abort.addEventListener("abort", onAbort, { once: true })
  })
  return withTimeout(
    Promise.race([promise, abortGuard]),
    timeoutMs,
    `vision model call timed out after ${timeoutMs}ms`,
  ).finally(() => { if (onAbort) ctx.abort.removeEventListener("abort", onAbort) })
}
```

行为等价于现实现（pre-abort 立即拒绝 / 到期 DeadlineError / abort AbortError / finally 清理），
仅超时错误类型由 `Error` 变为 `DeadlineError`（文案不变）。

## 错误处理原则

- 工具永不抛错不变：providers 超时、子会话超时/中止均收敛为既有可读错误路径。
- 超时不写缓存、不固化为"无视觉"；空链降级文案与 2026-09-05 spec 一致。
- abort 调用 best-effort：失败静默，不影响 delete 与整体清理。

## 已知限制（沿袭）

- `resolveChain` 把 providers 空结果 memoize 整进程（超时降级为空链后本次进程内不再重试）——
  属既有限制，R1 只消除"永久挂起"，不改变重试语义。
- dispose 对孤儿只 delete、不 abort（无回合状态依据）。

## 测试计划（TDD 先行）

helpers.ts 调整：

- `SessionCalls` 增 `aborted: string[]`；stub `session` 增 `abort({ path })` 实现（记录 id、返回 `{ data: true }`）。
- 既有 `session.create/prompt/delete` 不动（向后兼容，既有用例零 diff）。

plugin.test.ts 新增（R1）：

1. providers 永不 resolve + `providersTimeout.ms` 调小（25ms）→ chat.message（auto 模式、带图）不永久
   stall：正常返回、不注入 hint（空链降级）、`calls.providers === 1`；第二次同样消息 providers 不再
   增加（memoize 空链），完成后还原 `providersTimeout.ms`。
2. providers 挂起但 `imageSupport` 超时 → 返回 false 不缓存：可另以"超时后再次调用仍会重新查询"间接断言
   （次数递增）——若合并进用例 1 则省略独立用例。

plugin.test.ts 新增（R2）：

3. 超时路径：prompt 永不 resolve + `timeout_ms: 10` → 结果含既有超时文案；`calls.aborted` 含
   `ses_sub_1`；以测试内本地包装断言 `abort:id` 先于 `delete:id`（用临时 `order` 数组覆写 stub 的
   abort/delete 记录顺序）。
4. 成功路径：正常描述 → `calls.aborted` 为空（不 abort）。
5. 用户运行中 abort 路径（复刻既有"运行中 abort"用例）：`calls.aborted` 含 id、先于 delete。

既有回归：超时清理、dispose 兜底、运行中 abort、候选链等用例零 diff（stub 新增 abort 方法对既有
用例透明）。

## 文档更新

- README.md / README.zh.md：Roadmap 移除 R1、R2（已完成）与 R4（评审不做）；R5 保留未勾。
  已知限制更新：能力查询有 5s 超时（不再"无超时"）；孤儿回合在超时/中止路径先 abort 再删除
  （措辞改为描述残余边界而非全无处理）。
- 历史 spec（2026-09-05 / 09-07 / 09-08 等）属只读存档，不回改；本行为以本文档为契约。

## 验证门禁

```
bun run typecheck && bun test && bun run build
```

全绿为准；既有用例零 diff。
