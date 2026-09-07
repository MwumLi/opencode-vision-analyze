/**
 * opencode-vision-analyze 单元测试。
 *
 * 通过 stub 的插件运行环境（见 helpers.ts）直接调用钩子与工具，
 * 覆盖：导出形状 / 选项校验 / chat.message 门控与落盘 / 能力缓存 /
 * 工具描述路径 / 候选链 fallback 与 abort 语义 / 快速路径 / 描述缓存 /
 * URL 下载与错误路径 / 超时 / 永不抛错 / dispose 清理。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PluginOptions, ToolContext, ToolResult } from "@opencode-ai/plugin"
import {
  TINY_PNG,
  TINY_PNG_DATA_URL,
  TINY_PNG_SHA,
  MAIN_MODEL,
  VISION_MODEL,
  OTHER_VISION_MODEL,
  makeTempDir,
  removeDir,
  makeStubClient,
  makePluginInput,
  makeToolContext,
  loadPlugin,
  chatOutput,
  chatInput,
  providerStub,
  providersStub,
  type LoadedPlugin,
  type StubProvidersResult,
} from "./helpers"

/** 当前测试的临时项目目录（beforeEach 建立）。 */
let dir: string

beforeEach(async () => {
  dir = await makeTempDir()
})

afterEach(async () => {
  await removeDir(dir)
})

/** 文件是否存在（不抛错版）。 */
async function fileExists(filepath: string): Promise<boolean> {
  return access(filepath)
    .then(() => true)
    .catch(() => false)
}

/** 从 hooks 中取出 vision_analyze 工具的 execute（带类型收窄）。 */
function getAnalyze(hooks: LoadedPlugin["hooks"]) {
  const tool = (hooks.tool as Record<string, { execute: unknown }>)["vision_analyze"]
  if (!tool || typeof tool.execute !== "function") throw new Error("vision_analyze tool not registered")
  return tool.execute as (args: { image_path: string; question: string }, ctx: ToolContext) => Promise<ToolResult>
}

/** 标准工具上下文（独立 AbortController，可由测试手动 abort）。 */
function toolCtx(signal: AbortSignal) {
  return makeToolContext({ sessionID: "ses_1", directory: dir, signal })
}

/** 构造一个图片 file part（模拟用户贴图）。 */
function imagePart() {
  return {
    id: "prt_input_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "image/png",
    url: TINY_PNG_DATA_URL,
    filename: "tiny.png",
  }
}

/** 预期落盘路径（内容寻址命名）。 */
const persistedPath = () => path.join(dir, ".opencode", "vision", `${TINY_PNG_SHA}.png`)

describe("导出形状与选项校验", () => {
  test("default 导出为 { id, server }，id 为包名", async () => {
    const mod = (await import("../src/index")).default
    expect(mod.id).toBe("opencode-vision-analyze")
    expect(typeof mod.server).toBe("function")
  })

  test("model 格式非法（缺 provider/model 斜杠）：抛错并提示格式", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    await expect(loadPlugin(input, { model: "no-slash" } as PluginOptions)).rejects.toThrow(
      /option "model" must be in "provider\/model" format/,
    )
  })

  test("model 与 models 并存：抛错（互斥）", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    await expect(
      loadPlugin(input, { model: "test/vision-model", models: ["test/other-vision"] } as PluginOptions),
    ).rejects.toThrow(/mutually exclusive/)
  })

  test("models 含非法元素：抛错且信息含 models[1]", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    await expect(
      loadPlugin(input, { models: ["a/b", "no-slash"] } as PluginOptions),
    ).rejects.toThrow(/option "models\[1\]" must be in "provider\/model" format/)
  })

  test("model 与 models 均缺：自动模式正常加载并返回 hooks", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions)
    expect(hooks["chat.message"]).toBeTypeOf("function")
    expect(hooks.dispose).toBeTypeOf("function")
    expect(hooks.tool).toBeDefined()
  })

  test("宽容校验：unlisted_fallback / free_first 传非布尔按 false 处理，不抛错", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    const loaded = await loadPlugin(input, {
      model: "test/vision-model",
      unlisted_fallback: "yes",
      free_first: 1,
    } as unknown as PluginOptions)
    expect(loaded.hooks["chat.message"]).toBeTypeOf("function")
  })

  test("合法 model 选项正常加载并返回 hooks", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    expect(hooks["chat.message"]).toBeTypeOf("function")
    expect(hooks.dispose).toBeTypeOf("function")
  })
})

describe("chat.message 钩子", () => {
  test("无图片消息：不注入提示、不创建 vision 目录", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const out = chatOutput([{ type: "text", text: "hello" }])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)
    expect(out.parts.length).toBe(1)
    expect(await fileExists(path.join(dir, ".opencode", "vision"))).toBe(false)
  })

  test("无视觉主模型带图：注入 synthetic 提示并落盘", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)

    // 原始 file part 保留 + 追加一个 synthetic 提示 part
    expect(out.parts.length).toBe(2)
    const hint = out.parts[1] as { type: string; synthetic?: boolean; text: string }
    expect(hint.type).toBe("text")
    expect(hint.synthetic).toBe(true)
    expect(hint.text).toContain("vision_analyze")
    expect(hint.text).toContain(`image_path: ${persistedPath()}`)

    // 图片按内容哈希落盘
    expect(await fileExists(persistedPath())).toBe(true)
  })

  test("有视觉主模型带图：不注入提示、不落盘（能力门控）", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: OTHER_VISION_MODEL }), out)
    expect(out.parts.length).toBe(1)
    expect(await fileExists(persistedPath())).toBe(false)
  })

  test("递归防护：主模型即视觉模型时不做任何处理", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: VISION_MODEL }), out)
    expect(out.parts.length).toBe(1)
    expect(await fileExists(persistedPath())).toBe(false)
    // 递归防护在能力查询之前返回，不应触发 providers 调用
    expect(client.calls.providers).toBe(0)
  })

  test("整链递归防护：非链首候选（other-vision）的消息也不处理", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model", "test/other-vision"],
    } as PluginOptions)
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: OTHER_VISION_MODEL }), out)
    expect(out.parts.length).toBe(1)
    expect(await fileExists(persistedPath())).toBe(false)
    // 防护集是整条候选链：非链首成员命中同样在能力查询之前返回，不触发 providers
    expect(client.calls.providers).toBe(0)
  })

  test("空链降级：无 image-capable 模型时带图不注入提示、不落盘", async () => {
    const client = makeStubClient()
    client.setProvidersResult(providersStub(providerStub("test", "config", { "text-model": { image: false } })))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions)
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)
    // 原图 part 原样保留，无 synthetic hint（交给核心 unsupportedParts 默认处理）
    expect(out.parts.length).toBe(1)
    expect(out.parts.some((p) => p["synthetic"] === true)).toBe(false)
    // 空链不落盘：没有视觉模型可消费，落盘只是制造无人看的垃圾文件
    expect(await fileExists(persistedPath())).toBe(false)
  })

  test("能力查询结果进程级缓存：同模型两次消息只查一次", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    for (let i = 0; i < 2; i++) {
      const out = chatOutput([imagePart()])
      await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)
    }
    expect(client.calls.providers).toBe(1)
  })
})

describe("vision_analyze 工具", () => {
  test("工具已注册且带描述与参数 schema", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const tool = (hooks.tool as Record<string, { description: string; args: Record<string, unknown> }>)["vision_analyze"]
    expect(tool).toBeDefined()
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.args["image_path"]).toBeDefined()
    expect(tool.args["question"]).toBeDefined()
  })

  test("描述路径：创建子会话调用视觉模型并返回描述，子会话用后即删", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const analyze = getAnalyze(hooks)

    // 先落盘（供 loadImage 读取）
    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    expect(result.output).toContain("described by test/vision-model")
    expect(result.output).toContain("a red square")
    expect(result.title).toBe("vision_analyze")

    // 子会话生命周期：create（parentID 挂当前会话）→ prompt（视觉模型 + 图片 + 问题）→ delete
    expect(client.calls.create.length).toBe(1)
    expect(client.calls.create[0]?.parentID).toBe("ses_1")
    expect(client.calls.create[0]?.title).toBe("vision analysis")
    expect(client.calls.prompt.length).toBe(1)
    expect(client.calls.prompt[0]?.model).toEqual({ providerID: "test", modelID: "vision-model" })
    const parts = client.calls.prompt[0]?.parts as Array<Record<string, unknown>>
    expect(parts.some((p) => p["type"] === "file" && String(p["url"]).startsWith("data:image/png;base64,"))).toBe(true)
    expect(parts.some((p) => p["type"] === "text" && p["text"] === "what is this?")).toBe(true)
    expect(client.calls.deleted).toContain("ses_sub_1")
  })

  test("快速路径：会话主模型有视觉时直接回传原图附件，不调子会话", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })

    // 先经 chat.message 记录会话模型为有视觉的 other-vision（同时不注入提示）
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: OTHER_VISION_MODEL }), out)
    expect(out.parts.length).toBe(1)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await getAnalyze(hooks)(
      { image_path: persistedPath(), question: "look" },
      toolCtx(new AbortController().signal),
    )

    expect(result.attachments?.length).toBe(1)
    expect(result.attachments?.[0]?.url).toBe(TINY_PNG_DATA_URL)
    expect(result.attachments?.[0]?.mime).toBe("image/png")
    expect(client.calls.create.length).toBe(0)
    expect(client.calls.prompt.length).toBe(0)
  })

  test("描述缓存：同图同问题第二次直接命中，不再调用视觉模型", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const args = { image_path: persistedPath(), question: "same question" } as const
    const signal = new AbortController().signal

    const first = await analyze(args, toolCtx(signal))
    const second = await analyze(args, toolCtx(signal))

    expect(first.title).toBe("vision_analyze")
    expect(second.title).toBe("vision_analyze (cached)")
    expect(second.output).toContain("a red square")
    expect(client.calls.prompt.length).toBe(1)
  })

  test("描述缓存：命中输出沿用入库模型的标签而非链首重写", async () => {
    const client = makeStubClient()
    // 链首 vision-model 失败 → other-vision 成功产出并入库；命中缓存不再重调 prompt
    client.setPromptBehavior((model) =>
      model?.modelID === "vision-model"
        ? { error: new Error("boom for vision") }
        : { data: { parts: [{ type: "text", text: "a red square" }] } },
    )
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model", "test/other-vision"],
    } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const args = { image_path: persistedPath(), question: "same question" } as const
    const signal = new AbortController().signal

    const first = await analyze(args, toolCtx(signal))
    // 首次：链首 vision-model 失败 + other-vision 成功 → 共 2 次 prompt
    const promptsAfterFirst = client.calls.prompt.length
    const second = await analyze(args, toolCtx(signal))

    // 首次：other-vision 成功 → 标签标注实际产出的模型
    expect(first.title).toBe("vision_analyze")
    expect(first.output).toContain("described by test/other-vision")
    // 命中：标签沿用入库模型 other-vision，而非被 format 误写成链首 vision-model
    expect(second.title).toBe("vision_analyze (cached)")
    expect(second.output).toContain("described by test/other-vision")
    expect(second.output).toContain("a red square")
    // 命中不再发起任何 prompt：第二次调用前后 prompt 计数保持不变
    expect(client.calls.prompt.length).toBe(promptsAfterFirst)
  })

  test("本地文件不存在或扩展名不受支持：返回可读错误文字", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const analyze = getAnalyze(hooks)
    const signal = new AbortController().signal

    const missing = await analyze({ image_path: path.join(dir, "nope.png"), question: "x" }, toolCtx(signal))
    expect(missing.output).toContain("Image not found or unsupported")

    await writeFile(path.join(dir, "bad.svg"), "<svg/>")
    const badExt = await analyze({ image_path: path.join(dir, "bad.svg"), question: "x" }, toolCtx(signal))
    expect(badExt.output).toContain("Image not found or unsupported")
  })
})

describe("vision 候选链 fallback（describeWithChain）", () => {
  test("显式有序链：首候选失败自动续试下一候选，prompt 顺序与标签正确", async () => {
    const client = makeStubClient()
    // 首候选（vision-model）返回错误 → 应续试 other-vision 成功
    client.setPromptBehavior((model) =>
      model?.modelID === "vision-model"
        ? { error: new Error("boom for vision") }
        : { data: { parts: [{ type: "text", text: "a red square" }] } },
    )
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model", "test/other-vision"],
    } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    // 成功的是续试的候选 → 标签标注它
    expect(result.output).toContain("described by test/other-vision")
    expect(result.output).toContain("a red square")
    // prompt 按候选链顺序逐个尝试：首失败 → 次成功，不多调
    expect(client.calls.prompt.map((p) => p.model)).toEqual([
      { providerID: "test", modelID: "vision-model" },
      { providerID: "test", modelID: "other-vision" },
    ])
    // 每个候选各建/删一个子会话
    expect(client.calls.create.length).toBe(2)
    expect(client.calls.deleted.length).toBe(2)
  })

  test("全部候选失败：聚合各候选原因，不抛错", async () => {
    const client = makeStubClient()
    client.setPromptBehavior((model) =>
      model?.modelID === "vision-model"
        ? { error: new Error("boomA") }
        : { error: new Error("boomB") },
    )
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model", "test/other-vision"],
    } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "x" },
      toolCtx(new AbortController().signal),
    )

    expect(result.output).toContain("Image analysis failed: all 2 candidate model(s) failed")
    expect(result.output).toContain("test/vision-model: boomA")
    expect(result.output).toContain("test/other-vision: boomB")
    expect(result.title).toBe("vision_analyze")
  })

  test("运行中 abort：中止整链，不再尝试后续候选", async () => {
    const client = makeStubClient()
    // 首候选永不 resolve（模拟挂起）；后续候选即便正常也不应被推进
    client.setPromptBehavior((model) =>
      model?.modelID === "vision-model"
        ? new Promise(() => {})
        : { data: { parts: [{ type: "text", text: "a red square" }] } },
    )
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model", "test/other-vision"],
    } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const controller = new AbortController()
    const pending = analyze({ image_path: persistedPath(), question: "x" }, toolCtx(controller.signal))

    // 等首候选的 prompt 已发出（进入挂起）后再中止
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.calls.prompt.length).toBe(1)
    controller.abort()
    const result = await pending

    expect(result.output).toContain("Image analysis failed: Aborted")
    // 只尝试了首候选一次，没有推进 other-vision
    expect(client.calls.prompt.length).toBe(1)
    expect(client.calls.create.length).toBe(1)
  })

  test("空链：无 image-capable 模型时返回友好错误且不建子会话", async () => {
    const client = makeStubClient()
    client.setProvidersResult(providersStub(providerStub("test", "config", { "text-model": { image: false } })))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "x" },
      toolCtx(new AbortController().signal),
    )

    expect(result.output).toContain("Image analysis failed: no image-capable model configured")
    expect(client.calls.create.length).toBe(0)
  })
})

describe("自动发现排序（Provider.source 档序）", () => {
  /** 提供 config 源（custom-gw/cfg-vision）与 custom 源（opencode/mimo-free）两个 image-capable 模型。 */
  function dualSourceClient() {
    const client = makeStubClient()
    client.setProvidersResult(
      providersStub(
        providerStub("custom-gw", "config", { "cfg-vision": { image: true } }),
        providerStub("opencode", "custom", { "mimo-free": { image: true } }),
      ),
    )
    return client
  }

  test("默认档序：config 源视觉模型先于 custom 源（zen free）被尝试", async () => {
    const client = dualSourceClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    // config 源档位优先 → 首个尝试的是 custom-gw/cfg-vision，成功即止
    expect(result.output).toContain("described by custom-gw/cfg-vision")
    expect(client.calls.prompt[0]?.model).toEqual({ providerID: "custom-gw", modelID: "cfg-vision" })
    expect(client.calls.prompt.length).toBe(1)
  })

  test("free_first 反转：custom 源（zen free）视觉模型先于 config 源被尝试", async () => {
    const client = dualSourceClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { free_first: true } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    // free_first=true 档序反转 → 首个尝试的是 custom 源的 opencode/mimo-free
    expect(result.output).toContain("described by opencode/mimo-free")
    expect(client.calls.prompt[0]?.model).toEqual({ providerID: "opencode", modelID: "mimo-free" })
    expect(client.calls.prompt.length).toBe(1)
  })
})

describe("unlisted_fallback 续接", () => {
  /** 显式 test/vision-model（config 源）+ 未列出的 free/mimo-free（custom 源）image-capable 并存。 */
  function clientWithUnlisted() {
    const client = makeStubClient()
    client.setProvidersResult(
      providersStub(
        providerStub("test", "config", { "vision-model": { image: true }, "text-model": { image: false } }),
        providerStub("free", "custom", { "mimo-free": { image: true } }),
      ),
    )
    return client
  }

  test("正向：unlisted_fallback=true，显式 A 失败 → 续试未列出的 mimo-free 成功", async () => {
    const client = clientWithUnlisted()
    client.setPromptBehavior((model) =>
      model?.providerID === "test"
        ? { error: new Error("boom for vision") }
        : { data: { parts: [{ type: "text", text: "a red square" }] } },
    )
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model"],
      unlisted_fallback: true,
    } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    // 显式 A 失败后沿链续试到未列出的 custom 源模型 → 标签标注实际产出者
    expect(result.output).toContain("described by free/mimo-free")
    expect(result.output).toContain("a red square")
    expect(client.calls.prompt.map((p) => p.model)).toEqual([
      { providerID: "test", modelID: "vision-model" },
      { providerID: "free", modelID: "mimo-free" },
    ])
  })

  test("反向：unlisted_fallback=false（默认），同场景只试显式 A，不续试未列出模型", async () => {
    const client = clientWithUnlisted()
    client.setPromptBehavior(() => ({ error: new Error("boom for vision") }))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model"],
    } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    expect(result.output).toContain("Image analysis failed: all 1 candidate model(s) failed")
    expect(result.output).not.toContain("mimo-free")
    expect(client.calls.prompt.length).toBe(1)
    expect(client.calls.prompt[0]?.model).toEqual({ providerID: "test", modelID: "vision-model" })
  })

  test("退化：unlisted_fallback=true 但 inventory 无 image-capable → 链退化为纯显式 [A]", async () => {
    const client = makeStubClient()
    client.setProvidersResult(
      providersStub(
        providerStub("test", "config", { "vision-model": { image: true }, "text-model": { image: false } }),
        providerStub("free", "custom", { "mimo-free": { image: false } }),
      ),
    )
    client.setPromptBehavior(() => ({ error: new Error("boom for vision") }))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model"],
      unlisted_fallback: true,
    } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    // fallback 追加部分为空 → 链 = 纯显式 [A]，A 失败即全败（不续试无 image 能力的模型）
    expect(result.output).toContain("Image analysis failed: all 1 candidate model(s) failed")
    expect(result.output).not.toContain("mimo-free")
    expect(client.calls.prompt.length).toBe(1)
    expect(client.calls.prompt[0]?.model).toEqual({ providerID: "test", modelID: "vision-model" })
  })
})

describe("source 档位缺口（config/env/custom 与未知归档）", () => {
  /** config 源 a/ca、env 源 b/eb、custom 源 c/cc 三个 image-capable 模型并存（无显式配置）。 */
  function threeTierClient() {
    const client = makeStubClient()
    client.setProvidersResult(
      providersStub(
        providerStub("a", "config", { ca: { image: true } }),
        providerStub("b", "env", { eb: { image: true } }),
        providerStub("c", "custom", { cc: { image: true } }),
      ),
    )
    return client
  }

  test("档位推进：config 源 ca 失败 → 沿链续试 env 源 eb 成功", async () => {
    const client = threeTierClient()
    client.setPromptBehavior((model) =>
      model?.providerID === "a"
        ? { error: new Error("ca down") }
        : { data: { parts: [{ type: "text", text: "a red square" }] } },
    )
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    // 默认档序 config > env > custom：config 失败后不跳过 env 档直接续试成功，成功即止
    expect(result.output).toContain("described by b/eb")
    expect(client.calls.prompt.map((p) => p.model)).toEqual([
      { providerID: "a", modelID: "ca" },
      { providerID: "b", modelID: "eb" },
    ])
  })

  test("free_first：档序反转后首候选为 custom 源 c/cc", async () => {
    const client = threeTierClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { free_first: true } as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "what is this?" },
      toolCtx(new AbortController().signal),
    )

    // free_first=true → custom 源（免费优先）升到档首，成功即止
    expect(result.output).toContain("described by c/cc")
    expect(client.calls.prompt[0]?.model).toEqual({ providerID: "c", modelID: "cc" })
    expect(client.calls.prompt.length).toBe(1)
  })

  test("未知/缺失 source 归档3：排在 config/env 之后（最后一档）且可被续试", async () => {
    const client = makeStubClient()
    // providerStub 的 source 类型不含「缺失 / 任意字符串」，此处手写 providers 对象：
    // config 源 a/ca、env 源 b/eb 在高档；u1 缺 source、u2 带未知 "other" → 均归档最末档。
    client.setProvidersResult({
      data: {
        providers: [
          { id: "a", source: "config", models: { ca: { capabilities: { input: { image: true } } } } },
          { id: "b", source: "env", models: { eb: { capabilities: { input: { image: true } } } } },
          { id: "u1", models: { om: { capabilities: { input: { image: true } } } } },
          { id: "u2", source: "other", models: { ot: { capabilities: { input: { image: true } } } } },
        ],
      },
    } as unknown as StubProvidersResult)
    client.setPromptBehavior((model) =>
      model?.providerID === "a" || model?.providerID === "b" || model?.providerID === "u1"
        ? { error: new Error(`${model?.providerID} down`) }
        : { data: { parts: [{ type: "text", text: "a red square" }] } },
    )
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions)
    const analyze = getAnalyze(hooks)

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await analyze(
      { image_path: persistedPath(), question: "x" },
      toolCtx(new AbortController().signal),
    )

    // config/env 先于未知档被尝试；高档全失败后沿链续试到未知 source 模型成功
    expect(result.output).toContain("described by u2/ot")
    expect(client.calls.prompt.map((p) => p.model)).toEqual([
      { providerID: "a", modelID: "ca" },
      { providerID: "b", modelID: "eb" },
      { providerID: "u1", modelID: "om" },
      { providerID: "u2", modelID: "ot" },
    ])
  })
})

describe("URL 图片下载", () => {
  /** 保存/恢复 globalThis.fetch 的统一入口。 */
  function mockFetch(handler: typeof fetch): () => void {
    const original = globalThis.fetch
    globalThis.fetch = handler
    return () => {
      globalThis.fetch = original
    }
  }

  test("下载 http(s) 图片后走描述路径", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    let fetched = 0
    const restore = mockFetch((async () => {
      fetched += 1
      return new Response(TINY_PNG, { headers: { "content-type": "image/png" } })
    }) as typeof fetch)

    try {
      const result = await getAnalyze(hooks)(
        { image_path: "http://example.com/pic.png", question: "what?" },
        toolCtx(new AbortController().signal),
      )
      expect(fetched).toBe(1)
      // 下载内容落盘到统一 vision 目录（内容哈希命名）
      expect(await fileExists(persistedPath())).toBe(true)
      expect(result.output).toContain("a red square")
      expect(client.calls.prompt.length).toBe(1)
    } finally {
      restore()
    }
  })

  test("404：返回下载失败文字，不创建子会话", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const restore = mockFetch((async () => new Response("nope", { status: 404 })) as typeof fetch)
    try {
      const result = await getAnalyze(hooks)(
        { image_path: "http://example.com/pic.png", question: "x" },
        toolCtx(new AbortController().signal),
      )
      expect(result.output).toContain("Image download failed: HTTP 404")
      expect(client.calls.create.length).toBe(0)
    } finally {
      restore()
    }
  })

  test("超过 20MB（content-length 预检）：拒绝下载", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    // downloadImage 只使用 ok/status/headers.get/arrayBuffer，用最小 Response 形状即可确定性构造
    const fake = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(21 * 1024 * 1024) }),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response
    const restore = mockFetch((async () => fake) as typeof fetch)
    try {
      const result = await getAnalyze(hooks)(
        { image_path: "http://example.com/pic.png", question: "x" },
        toolCtx(new AbortController().signal),
      )
      expect(result.output).toContain("image exceeds 20 MB download limit")
    } finally {
      restore()
    }
  })

  test("不受支持的 URL 扩展名：不发起请求直接拒绝", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    let fetched = 0
    const restore = mockFetch((async () => {
      fetched += 1
      return new Response(TINY_PNG)
    }) as typeof fetch)
    try {
      const result = await getAnalyze(hooks)(
        { image_path: "http://example.com/pic.svg", question: "x" },
        toolCtx(new AbortController().signal),
      )
      expect(result.output).toContain("unsupported image URL extension: .svg")
      expect(fetched).toBe(0)
    } finally {
      restore()
    }
  })

  test("网络异常：错误文字返回而非抛错", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    const restore = mockFetch((async () => {
      throw new Error("network boom")
    }) as typeof fetch)
    try {
      const result = await getAnalyze(hooks)(
        { image_path: "http://example.com/pic.png", question: "x" },
        toolCtx(new AbortController().signal),
      )
      expect(result.output).toContain("Image download failed: network boom")
    } finally {
      restore()
    }
  })
})

describe("超时 / 中止 / 容错", () => {
  test("超时：timeout_ms 到期后返回超时错误并清理子会话", async () => {
    const client = makeStubClient()
    client.setPromptBehavior(() => new Promise(() => {}))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      model: "test/vision-model",
      timeout_ms: 10,
    })

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await getAnalyze(hooks)(
      { image_path: persistedPath(), question: "x" },
      toolCtx(new AbortController().signal),
    )

    // 超时文案聚合进全败信息：单候选链 → all 1 candidate model(s) failed
    expect(result.output).toContain("all 1 candidate model(s) failed")
    expect(result.output).toContain("vision model call timed out after 10ms")
    // 超时路径的 finally 仍会删除子会话
    expect(client.calls.deleted).toContain("ses_sub_1")
  })

  test("预先中止的 signal：立即以 Aborted 结束", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)

    const controller = new AbortController()
    controller.abort()
    const result = await getAnalyze(hooks)({ image_path: persistedPath(), question: "x" }, toolCtx(controller.signal))
    expect(result.output).toContain("Image analysis failed: Aborted")
  })

  test("子会话创建失败：返回错误文字而非抛错", async () => {
    const client = makeStubClient()
    // 直接覆写 stub 行为：create 抛错
    ;(client.session as { create: unknown }).create = async () => {
      throw new Error("create boom")
    }
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { model: "test/vision-model" })
    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)

    const result = await getAnalyze(hooks)(
      { image_path: persistedPath(), question: "x" },
      toolCtx(new AbortController().signal),
    )
    // 创建失败同样收敛为全败聚合文案
    expect(result.output).toContain("all 1 candidate model(s) failed")
    expect(result.output).toContain("create boom")
  })

  test("dispose：兜底清理挂起路径上的孤儿子会话", async () => {
    const client = makeStubClient()
    client.setPromptBehavior(() => new Promise(() => {}))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      model: "test/vision-model",
      timeout_ms: 60_000,
    })

    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const controller = new AbortController()
    const pending = getAnalyze(hooks)({ image_path: persistedPath(), question: "x" }, toolCtx(controller.signal))

    // 等待 create 完成（子会话进入 subSessions，prompt 挂起）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.calls.create.length).toBe(1)

    // dispose 兜底删除孤儿子会话
    await hooks.dispose?.()
    expect(client.calls.deleted).toContain("ses_sub_1")

    // abort 让挂起的 analyze 收尾，避免悬挂 timer
    controller.abort()
    const result = await pending
    expect(result.output).toContain("Image analysis failed: Aborted")
  })
})
