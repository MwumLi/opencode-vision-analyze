# 多视觉模型候选链（fallback chain）实施计划

> 供实现者逐 Task 执行。行为契约以 spec 为准：`docs/superpowers/specs/2026-09-07-model-chain-fallback-design.md`。
> 硬性要求：**新增/修改代码必须带必要的中文注释、符合人类阅读习惯**；每 Task 结束跑 `bun test`，全部 Task 结束跑 `bun run typecheck && bun test && bun run build` 且全绿；按 Task 提交 git。

**Goal**: 把视觉模型选择重构为「归一化候选数组 + 单一链式尝试路径」，实现多模型有序 fallback、自动发现与 source 档序、空链降级。

**Architecture**: 改动集中在单文件插件 `src/index.ts`（curl 单文件分发约束不拆文件）+ `test/helpers.ts` + `test/plugin.test.ts` + 文档。核心新概念：懒加载 `resolveChain()` 产出统一候选链；`attemptModel()` 单候选尝试 + `describeWithChain()` 逐候选推进；缓存值 `{ modelId, text }`；chat.message 递归防护用 chain 全体成员。

**Tech Stack**: TypeScript / bun test；零运行时依赖。

---

## 变更（2026-09-08）：移除 `model`，唯一入口 `models`

用户决策：新项目不保留兼容 → `models: string[]` 成为唯一显式配置入口，`model` 单字符串选项删除（单模型写作 `models:["x"]`）。

已执行（commit `5df3523`）：

- `src/index.ts`：删除 `modelOption`/`hasModel`/互斥抛错分支；`models` 给定但非数组 → 抛错（提示需为 `"provider/model"` 字符串数组）；`models` 缺省或 `[]` → 自动模式；docstring 与空链文案同步去掉 `model`。
- `test/plugin.test.ts`：机械替换插件选项 `model:` → `models: [...]`；校验用例改写（非数组抛错 / `[]` 自动模式 / 下标 `models[i]` 报错），42 pass。
- 文档：README 双语选项表与示例、fallback spec（含本变更记录）、09-05 快照头部注释已同步。

本计划 Task 2 中「`model` 与 `models` 并存报错 / `model` 单字符串入口」等旧步骤已被上述变更取代，仅作历史记录保留。

---

## 文件映射

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/index.ts` | 改 | 选项解析、resolveChain、链式描述、钩子、工具 |
| `test/helpers.ts` | 改 | providers stub 带 source/多 provider/多模型；promptBehavior 收 model |
| `test/plugin.test.ts` | 改 | 更新旧断言 + 新增链式/排序/空链/缓存用例 |
| `docs/superpowers/specs/2026-09-05-opencode-vision-analyze-design.md`、`README.md`、`README.zh.md` | 改 | 同步新选项与行为 |
| `docs/superpowers/specs/2026-09-07-model-chain-fallback-design.md` | 改 | 定稿（去掉「草稿」状态行） |

---

## Task 1：helpers stub 升级

**Files**: `test/helpers.ts`

- [ ] Step 1: 类型 `StubProvidersResult` 的 provider 增加 `source: "config" | "env" | "api" | "custom"`；默认 providers 单 provider `test`（`source: "config"`），models 保持 text-model/vision-model/other-vision。
- [ ] Step 2: 增加便捷构造：`providerStub(id, source, models: Record<string,{image:boolean}>)` 返回 provider 对象；`providersStub(...providers)` 返回 `{data:{providers}}`。`StubModel` 仍为 `{ capabilities: { input: { image: boolean } } }`（cost 暂不需要，模型可加 `cost` 但插件当前不读）。
- [ ] Step 3: `session.prompt` 改为把 `body.model` 传给 `promptBehavior(body.model)`（现有无参 behavior 不受影响）。`setPromptBehavior` 类型签名改为 `(behavior: (model?: {providerID:string; modelID:string}) => Promise<unknown>)`。
- [ ] Step 4: 跑 `bun test`，旧用例应全绿（行为未变）。
- [ ] Step 5: commit `chore(test): stub providers with source and model-aware prompt behavior`

## Task 2：选项解析改造（model/models 归一化）

**Files**: `src/index.ts` 选项解析区（约 100-115 行）与顶层「/ 分隔」拆解逻辑

- [ ] Step 1: 在 `test/plugin.test.ts`「导出形状与选项校验」改写/新增失败测试：
  - `model`+`models` 并存 → 抛错（含 mutually exclusive）
  - `model` 非法（无 `/`）→ 抛错；`models:["a/b","no-slash"]` → 抛错且信息含 `models[1]`
  - 均缺 → **正常加载**（不再抛「requires model」，返回 hooks，自动模式）
  - `unlisted_fallback`/`free_first` 传非布尔（如 `"yes"`、`1`）→ 正常加载、按 false 处理
- [ ] Step 2: 确认失败（RUN `bun test test/plugin.test.ts`）。
- [ ] Step 3: 实现（参考代码，可内联进 plugin 闭包前部）：

```ts
// ---- 选项解析与校验 ----------------------------------------------------
// 归一化规则：model 是单字符串（等价 models:[...]）；models 是有序候选数组；
// 二者并存视为冲突报错。两者均缺 → explicit 为空（进入自动发现，见 resolveChain）。
const modelOption = optionsArg?.model
const modelsOption = optionsArg?.models
const hasModel = typeof modelOption === "string" && modelOption.trim() !== ""
const hasModels = Array.isArray(modelsOption) && modelsOption.length > 0
if (hasModel && hasModels) {
  throw new Error('opencode-vision-analyze options "model" and "models" are mutually exclusive')
}
// 收集字符串候选并逐项校验 provider/model 格式（modelID 允许含 "/"，按首个 "/" 切分）
const raw = hasModel ? [modelOption as string] : hasModels ? (modelsOption as string[]) : []
const explicitModels: Array<{ providerID: string; modelID: string }> = []
const seenKeys = new Set<string>()
raw.forEach((item, index) => {
  const label = hasModel ? "model" : `models[${index}]`
  if (typeof item !== "string" || !item.includes("/")) {
    throw new Error(
      `opencode-vision-analyze option "${label}" must be in "provider/model" format, got: ${JSON.stringify(item)}`,
    )
  }
  const sep = item.indexOf("/")
  if (seenKeys.has(item)) return // 保序去重：重复模型只保留首个
  seenKeys.add(item)
  explicitModels.push({ providerID: item.slice(0, sep), modelID: item.slice(sep + 1) })
})
// unlisted_fallback：显式链耗尽后是否自动续接未列出的 image-capable 模型（仅显式配置时生效）
const fallbackUnlisted = optionsArg?.unlisted_fallback === true
// free_first：自动发现档序是否反转（匿名/内置 custom 优先，默认 config 优先）
const freeFirst = optionsArg?.free_first === true
```

- [ ] Step 4: `bun test` 通过（删除被替换的旧「缺 model 抛错」用例）。`timeout_ms` 解析保持不动。
- [ ] Step 5: commit `feat: normalize model/models options into explicit candidate list`

## Task 3：resolveChain + source 档序 + free_first

**Files**: `src/index.ts`（紧邻 imageSupport 区域新增；visionAnalyze/onChatMessage 先暂不接，Task 4/6 接入）

- [ ] Step 1: 失败测试放 Task 7 口径前先以「自动模式工具首个 prompt 候选」断言（Task 4 后再断言顺序），因此本 Task 测试可与 Task 4 合并验收；此处先以 `bun run typecheck` 与既有 `bun test` 不回归为门槛，并实现下述纯逻辑（先不动工具/钩子，逻辑不可达，测试随后续 Task 补）。
- [ ] Step 2: 实现（参考代码）：

```ts
/** Provider.source → 自动发现档位：config 最优先，env/api 次之，custom 与未知值最末 */
const tierOfSource = (source: string): number =>
  source === "config" ? 0 : source === "env" || source === "api" ? 1 : 2

/** "provider/model" 引用键 */
const modelRefKey = (c: { providerID: string; modelID: string }): string => `${c.providerID}/${c.modelID}`

// 候选链 memoize（chat.message 与 vision_analyze 共享一次 providers 查询）
let chainPromise: Promise<Array<{ providerID: string; modelID: string }>> | undefined
/**
 * 归一化产出最终候选链（统一数组，运行时只做逐个尝试）：
 * - 显式非空：显式链恒在链首；unlisted_fallback=true 时追加未列出的 image-capable 模型
 * - 显式为空：整链 = 自动发现（全部 image-capable 模型）
 */
const resolveChain = (): Promise<Array<{ providerID: string; modelID: string }>> => {
  chainPromise ??= (async () => {
    if (explicitModels.length === 0) return listImageCapableModels()
    if (!fallbackUnlisted) return explicitModels
    const inventory = await listImageCapableModels()
    const explicitSet = new Set(explicitModels.map(modelRefKey))
    return [...explicitModels, ...inventory.filter((c) => !explicitSet.has(modelRefKey(c)))]
  })()
  return chainPromise
}

/**
 * 枚举 config.providers() 中全部 image-capable 模型，并按 Provider.source 档位
 * 稳定排序（档内保持返回顺序）。free_first=true 时档序反转（匿名/内置优先）。
 * 顺带预填 imageCapable 缓存（与 imageSupport 同源）。
 */
const listImageCapableModels = async (): Promise<Array<{ providerID: string; modelID: string }>> => {
  try {
    const result = await input.client.config.providers()
    if (!result.data) return []
    const found: Array<{ providerID: string; modelID: string; tier: number }> = []
    for (const provider of result.data.providers ?? []) {
      const tier = tierOfSource(provider.source)
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        if (model.capabilities?.input?.image !== true) continue
        imageCapable.set(`${provider.id}/${modelID}`, true)
        found.push({ providerID: provider.id, modelID, tier })
      }
    }
    // 稳定排序：默认 config>env/api>custom（升序）；free_first 反转（降序）
    found.sort((a, b) => (freeFirst ? b.tier - a.tier : a.tier - b.tier))
    return found.map(({ providerID, modelID }) => ({ providerID, modelID }))
  } catch {
    return []
  }
}

/** 判断某 model 是否为当前候选链成员（chat.message 递归防护用） */
const isCandidateModel = async (model: { providerID: string; modelID: string }): Promise<boolean> => {
  const chain = await resolveChain()
  return chain.some((c) => c.providerID === model.providerID && c.modelID === model.modelID)
}
```

- [ ] Step 3: `bun run typecheck` 通过；`bun test` 不回归。
- [ ] Step 4: commit `feat: resolve ordered vision candidate chain by provider.source`

## Task 4：链式描述 attempt / describeWithChain

**Files**: `src/index.ts`（`describeImage` 整体重构为两层；`visionAnalyze` 改用 describeWithChain）

- [ ] Step 1: 新增失败测试（`test/plugin.test.ts`）：
  1. 显式 `models:["test/vision-model","test/other-vision"]`；令 `vision-model` prompt 失败、`other-vision` 成功 → 返回 other-vision 标签、`client.calls.prompt` 顺序 `[vision-model, other-vision]`。
  2. 两候选均失败 → 输出聚合含 `all 2 candidate model(s) failed` 与两 `provider/model: reason`。
  3. 候选 A 挂起，运行中 abort → `client.calls.prompt` 仅 1 次，输出含 `Aborted`，不推进 B。
  4. 空链（providers 全 image:false，无显式配置）→ 工具输出 no image-capable model configured，不建子会话。
- [ ] Step 2: 确认失败。
- [ ] Step 3: 重构实现（参考代码）：

```ts
/** 判断错误是否为 AbortError（中止信号） */
const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError"

/**
 * 单个候选尝试：创建子会话（parentID 挂当前会话）→ 用该候选模型描述 → 删除子会话。
 * 任何失败捕获为 { ok:false }（不向上抛，交给链循环推进）；abort 标记 aborted 供中止整链。
 */
const attemptModel = async (
  candidate: { providerID: string; modelID: string },
  image: { bytes: Buffer; mime: string },
  question: string,
  ctx: ToolContext,
): Promise<{ ok: true; text: string } | { ok: false; error: string; aborted?: boolean }> => {
  const dataURL = `data:${image.mime};base64,${image.bytes.toString("base64")}`
  let subID: string | undefined
  try {
    const created = await withDeadline(
      input.client.session.create({ body: { parentID: ctx.sessionID, title: "vision analysis" } }),
      ctx,
    )
    if (created.error || !created.data) {
      return { ok: false, error: `session create failed: ${errText(created.error)}` }
    }
    subID = created.data.id
    subSessions.add(subID)
    const response = await withDeadline(
      input.client.session.prompt({
        path: { id: subID },
        body: {
          model: { providerID: candidate.providerID, modelID: candidate.modelID },
          agent: "build",
          tools: { "*": false },
          system: VISION_SYSTEM_PROMPT,
          parts: [
            { type: "file", mime: image.mime, url: dataURL },
            { type: "text", text: question },
          ],
        },
      }),
      ctx,
    )
    if (response.error || !response.data) {
      return { ok: false, error: errText(response.error) || "vision model prompt returned no data" }
    }
    const text = response.data.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
    if (!text) return { ok: false, error: "vision model returned no text" }
    return { ok: true, text }
  } catch (error) {
    // 异常（超时/中止/底层抛错）也收敛为失败结果，交给链循环决策
    return { ok: false, error: errText(error), aborted: isAbortError(error) }
  } finally {
    if (subID) {
      subSessions.delete(subID)
      await input.client.session.delete({ path: { id: subID } }).catch(() => {})
    }
  }
}

/**
 * 候选链描述：沿 chain 逐个尝试，首个成功即返回；失败记录并推进下一个；
 * abort 立即中止整链；全部失败返回聚合错误；空链返回友好错误。永不抛错。
 */
const describeWithChain = async (
  image: { bytes: Buffer; mime: string },
  question: string,
  ctx: ToolContext,
): Promise<{ ok: true; text: string; modelId: string } | { ok: false; error: string }> => {
  if (ctx.abort.aborted) return { ok: false, error: "Aborted" }
  const chain = await resolveChain()
  const failures: string[] = []
  for (const candidate of chain) {
    const attempt = await attemptModel(candidate, image, question, ctx)
    if (attempt.ok) return { ok: true, text: attempt.text, modelId: modelRefKey(candidate) }
    if (attempt.aborted) return { ok: false, error: attempt.error } // abort 中止整链
    failures.push(`${modelRefKey(candidate)}: ${attempt.error}`)
  }
  if (failures.length === 0) {
    return {
      ok: false,
      error:
        "no image-capable model configured (set the plugin model/models option or configure an image-capable provider model)",
    }
  }
  return { ok: false, error: `all ${failures.length} candidate model(s) failed: ${failures.join("; ")}` }
}
```

- [ ] Step 4: `visionAnalyze` 把「缓存未命中 → describeImage」替换为 `describeWithChain`（缓存值结构 Task 5 改，此处先用 text 暂存兼容）。
- [ ] Step 5: 更新旧断言：超时/创建失败/无文本等失败文案改为「聚合形式」下的关键子串断言（如 `toContain("vision model call timed out after 10ms")`、`toContain("create boom")`、`toContain("Aborted")`）；保留不建子会话/清理断言。`bun test` 通过。
- [ ] Step 6: commit `feat: try vision candidates in chain order with abort/aggregate semantics`

## Task 5：缓存带 modelId + 标签真实

**Files**: `src/index.ts`（descriptions Map、visionAnalyze 缓存读写与 format）

- [ ] Step 1: 失败测试：同图同问题，先由 A（链首）成功入库；随后（换场景使链首为 B 的配置）命中缓存 → 标签仍为 A（输出含 `described by test/vision-model` 而非 B）；命中 title 含 `(cached)`。
- [ ] Step 2: 实现：
  - `descriptions: Map<string, { modelId: string; text: string }>`
  - 命中：`format(cached.modelId, cached.text)`；未命中：`describeWithChain` 成功 → `descriptions.set(key, { modelId: result.modelId, text: result.text })`。
  - `format(modelId, text)` 改签名：`` `[Image: ${basename} — described by ${modelId}]\n${text}` ``。
- [ ] Step 3: 同步调整 Task 4 引入的暂存逻辑；`bun test` 通过。
- [ ] Step 4: commit `feat: tag cached description with original model id`

## Task 6：chat.message 递归防护 + 空链降级 + 文档

**Files**: `src/index.ts` onChatMessage、`README.md`、`README.zh.md`、`docs/superpowers/specs/2026-09-05-opencode-vision-analyze-design.md`、spec 定稿

- [ ] Step 1: 失败测试：
  1. 递归防护：配置 `models:[A,B]`，消息模型 = B（非首候选）→ 不注入、不落盘。
  2. 自动模式默认档序：providers 含 config 源 image 模型 + custom 源（zen free）image 模型 → chat.message 注入 hint；工具调用首个 prompt 候选为 config 源模型。
  3. `free_first:true` 同样 providers → 首个候选为 custom 源（zen free）模型。
  4. 空链（无 image-capable）→ chat.message 带图不注入 hint（parts 不变）。
- [ ] Step 2: 实现 onChatMessage 顺序（参考代码）：

```ts
  const onChatMessage: NonNullable<Hooks["chat.message"]> = async (hookInput, output) => {
    // 记录会话当前模型（先于递归防护：会话模型恰为视觉模型时也需记录）
    if (hookInput.model) sessionModels.set(hookInput.sessionID, hookInput.model)
    // 只处理 base64 图片附件；没有图片就没有副作用
    const images = output.parts.filter(
      (part): part is FilePart => part.type === "file" && part.mime.startsWith("image/"),
    )
    if (images.length === 0) return
    // 递归防护：候选链内模型（我们的描述子会话）的消息不再处理（chain 懒加载 memoized）
    if (hookInput.model && (await isCandidateModel(hookInput.model))) return
    // 能力门控：主模型有视觉能力 → 原图直发，不需要任何提示
    const current = hookInput.model ?? sessionModels.get(hookInput.sessionID)
    if (current && (await imageSupport(current.providerID, current.modelID))) return
    // 空链降级：没有任何可用视觉模型时不注入 hint，交给核心 unsupportedParts 默认处理
    const chain = await resolveChain()
    if (chain.length === 0) return
    // 每张图落盘并生成提示行（原逻辑）
    ...原有 persist/hint 逻辑...
  }
```

- [ ] Step 3: `bun test` 全绿；`bun run typecheck`、`bun run build` 通过。
- [ ] Step 4: 文档：
  - `README.md` / `README.zh.md`：选项表加 `models`、`unlisted_fallback`、`free_first`；`model` 标可选；移除「单模型无备选链」限制；补候选链示例与「发现排序（Provider.source 档序）+ zen free 免登录」说明。
  - `docs/superpowers/specs/2026-09-05-opencode-vision-analyze-design.md`：新增决策行（候选链归一化/单一路径/fallback 构建期语义/发现排序按 source/free_first/缓存 modelId/空链降级）。
  - spec 顶部状态行改「定稿」。
- [ ] Step 5: commit `feat: chain-wide recursion guard, empty-chain fallback, docs`

---

## 全量门禁（每 Task 后至少 `bun test`；最终 Task 6 后全量）

```
bun run typecheck
bun test
bun run build
```

## 收尾

- 每个 Task 完成：跑门禁 → git commit → 蓝信通知（当前任务进展 + 整体进度 N/6）。
- 全部完成后：`council` 议会验收 → 输出报告 → 生成验收 checklist（验收项/步骤/效果）→ 蓝信通知用户验收。
