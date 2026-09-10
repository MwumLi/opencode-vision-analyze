/**
 * opencode-vision-analyze 单元测试。
 *
 * 通过 stub 的插件运行环境（见 helpers.ts）直接调用钩子与工具，
 * 覆盖：导出形状 / 选项校验 / chat.message 门控与落盘 / 能力缓存 /
 * 工具描述路径 / 候选链 fallback 与 abort 语义 / 快速路径 / 描述缓存 /
 * URL 下载与错误路径 / 超时 / 永不抛错 / dispose 清理。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, writeFile, readdir, stat, readFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
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
import {
  providersTimeout,
  resolveDescriptionDir,
  descriptionCacheLimits,
  visionCacheLimits,
  userVisionCacheRoot,
  GENERIC_QUESTION,
  genericWriteMinText,
  isGenericQuestion,
  normalizeQuestion,
} from "../src/index"

/** 当前测试的临时项目目录（beforeEach 建立）。 */
let dir: string
/** 每次测试独立临时用户缓存根（XDG_CACHE_HOME）——描述缓存走用户级目录，需隔离防跨测试污染/写真实 home。 */
let cacheHome: string
/** 记录测试前的 XDG_CACHE_HOME，afterEach 还原。 */
let prevXdgHome: string | undefined

beforeEach(async () => {
  dir = await makeTempDir()
  cacheHome = await mkdtemp(path.join(tmpdir(), "vision-cache-"))
  prevXdgHome = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = cacheHome
})

afterEach(async () => {
  if (prevXdgHome === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = prevXdgHome
  await removeDir(dir)
  await removeDir(cacheHome)
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
  return tool.execute as (args: { image_path: string; question?: string }, ctx: ToolContext) => Promise<ToolResult>
}

/** 标准工具上下文（独立 AbortController，可由测试手动 abort）。 */
function toolCtx(signal: AbortSignal) {
  return makeToolContext({ sessionID: "ses_1", directory: dir, signal })
}

/** 构造一个图片 file part（模拟用户贴图）；可注入 source 等字段覆盖。 */
function imagePart(overrides: Record<string, unknown> = {}) {
  return {
    id: "prt_input_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "image/png",
    url: TINY_PNG_DATA_URL,
    filename: "tiny.png",
    ...overrides,
  }
}

/** 预期图片落盘路径（用户级 vision 缓存目录，内容寻址命名）。 */
const visionDir = () => path.join(cacheHome, "opencode-vision-analyze", "vision")
const persistedPath = () => path.join(visionDir(), `${TINY_PNG_SHA}.png`)

describe("导出形状与选项校验", () => {
  test("default 导出为 { id, server }，id 为包名", async () => {
    const mod = (await import("../src/index")).default
    expect(mod.id).toBe("opencode-vision-analyze")
    expect(typeof mod.server).toBe("function")
  })

  test("models 含非法元素（缺 provider/model 斜杠）：抛错且信息含 models[0]", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    await expect(loadPlugin(input, { models: ["no-slash"] } as PluginOptions)).rejects.toThrow(
      /option "models\[0\]" must be in "provider\/model" format/,
    )
  })

  test("models 传了字符串而非数组：抛错并提示类型", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    await expect(loadPlugin(input, { models: "test/vision-model" } as PluginOptions)).rejects.toThrow(
      /option "models" must be an array of "provider\/model" strings/,
    )
  })

  test("models 含非法元素：抛错且信息含 models[1]", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    await expect(
      loadPlugin(input, { models: ["a/b", "no-slash"] } as PluginOptions),
    ).rejects.toThrow(/option "models\[1\]" must be in "provider\/model" format/)
  })

  test("models 缺省：自动模式正常加载并返回 hooks", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions)
    expect(hooks["chat.message"]).toBeTypeOf("function")
    expect(hooks.dispose).toBeTypeOf("function")
    expect(hooks.tool).toBeDefined()
  })

  test("models 为空数组：同样视为自动模式正常加载", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: [] } as PluginOptions)
    expect(hooks["chat.message"]).toBeTypeOf("function")
    expect(hooks.tool).toBeDefined()
  })

  test("宽容校验：unlisted_fallback / free_first 传非布尔按 false 处理，不抛错", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    const loaded = await loadPlugin(input, {
      models: ["test/vision-model"],
      unlisted_fallback: "yes",
      free_first: 1,
    } as unknown as PluginOptions)
    expect(loaded.hooks["chat.message"]).toBeTypeOf("function")
  })

  test("合法 models 选项正常加载并返回 hooks", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    expect(hooks["chat.message"]).toBeTypeOf("function")
    expect(hooks.dispose).toBeTypeOf("function")
  })
})

describe("chat.message 钩子", () => {
  test("无图片消息：不注入提示、不创建 vision 缓存目录", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const out = chatOutput([{ type: "text", text: "hello" }])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)
    expect(out.parts.length).toBe(1)
    expect(await fileExists(visionDir())).toBe(false)
  })

  test("无视觉主模型带图：注入 synthetic 提示并落盘", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)

    // 原始 file part 保留 + 追加一个 synthetic 提示 part
    expect(out.parts.length).toBe(2)
    const hint = out.parts[1] as { type: string; synthetic?: boolean; text: string }
    expect(hint.type).toBe("text")
    expect(hint.synthetic).toBe(true)
    expect(hint.text).toContain("vision_analyze")
    expect(hint.text).toContain(`image_path: ${persistedPath()}`)
    // 契约：提示词必须教主模型“泛解析省略 question”，避免它每次自编措辞导致缓存 key 分片
    expect(hint.text).toContain("WITHOUT a question")

    // 图片按内容哈希落盘
    expect(await fileExists(persistedPath())).toBe(true)
  })

  test("路径粘贴（source.path 指向真实图片）：原位读用、不落盘", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const srcPath = path.join(dir, "src.png")
    await writeFile(srcPath, TINY_PNG)
    const out = chatOutput([
      imagePart({ source: { type: "file", path: srcPath, text: { value: "[Image 1]", start: 0, end: 9 } } }),
    ])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)

    const hint = out.parts[1] as { type: string; text: string }
    expect(hint.text).toContain(`image_path: ${srcPath}`)
    // 路径粘贴不复制进 vision 缓存
    expect(await fileExists(persistedPath())).toBe(false)
  })

  test("路径粘贴（相对路径）：以 input.directory 为基准绝对化、不落盘", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const rel = path.join("sub", "x.png")
    await mkdir(path.join(dir, "sub"), { recursive: true })
    await writeFile(path.join(dir, rel), TINY_PNG)
    const out = chatOutput([
      imagePart({ source: { type: "file", path: rel, text: { value: "[Image 1]", start: 0, end: 9 } } }),
    ])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)

    const hint = out.parts[1] as { text: string }
    expect(hint.text).toContain(`image_path: ${path.resolve(dir, rel)}`)
    expect(await fileExists(persistedPath())).toBe(false)
  })

  test("路径粘贴但源文件不存在：回退内容寻址落盘", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const out = chatOutput([
      imagePart({
        source: { type: "file", path: path.join(dir, "nope.png"), text: { value: "[Image 1]", start: 0, end: 9 } },
      }),
    ])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)

    const hint = out.parts[1] as { text: string }
    expect(hint.text).toContain(`image_path: ${persistedPath()}`)
    expect(await fileExists(persistedPath())).toBe(true)
  })

  test("路径粘贴但扩展名不受支持：回退内容寻址落盘", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const binPath = path.join(dir, "foo.bin")
    await writeFile(binPath, TINY_PNG)
    const out = chatOutput([
      imagePart({ source: { type: "file", path: binPath, text: { value: "[Image 1]", start: 0, end: 9 } } }),
    ])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)

    const hint = out.parts[1] as { text: string }
    expect(hint.text).toContain(`image_path: ${persistedPath()}`)
    expect(await fileExists(persistedPath())).toBe(true)
  })

  test("路径粘贴：源文件内容变化后，vision_analyze 取最新内容", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)
    const srcPath = path.join(dir, "live.png")
    await writeFile(srcPath, TINY_PNG)

    const out = chatOutput([
      imagePart({ source: { type: "file", path: srcPath, text: { value: "[Image 1]", start: 0, end: 9 } } }),
    ])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)
    const hint = out.parts[1] as { text: string }
    expect(hint.text).toContain(`image_path: ${srcPath}`)

    // 粘贴后文件内容被改写 → 工具当场重读应拿到新内容（而非消息里的旧快照）
    const next = Buffer.from("brand new image bytes")
    await writeFile(srcPath, next)

    const result = await analyze(
      { image_path: srcPath, question: "what is this?" },
      toolCtx(new AbortController().signal),
    )
    expect(result.title).toBe("vision_analyze")
    const parts = client.calls.prompt[0]?.parts as Array<Record<string, unknown>>
    const filePart = parts.find((p) => p["type"] === "file") as { url: string }
    expect(filePart.url).toBe(`data:image/png;base64,${next.toString("base64")}`)
  })

  test("有视觉主模型带图：不注入提示、不落盘（能力门控）", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const out = chatOutput([imagePart()])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: OTHER_VISION_MODEL }), out)
    expect(out.parts.length).toBe(1)
    expect(await fileExists(persistedPath())).toBe(false)
  })

  test("递归防护：主模型即视觉模型时不做任何处理", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const tool = (hooks.tool as Record<string, { description: string; args: Record<string, unknown> }>)["vision_analyze"]
    expect(tool).toBeDefined()
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.args["image_path"]).toBeDefined()
    expect(tool.args["question"]).toBeDefined()
    // 契约：question 语义为可选，且不能再用旧文案鼓励“具体一点”（那会诱导措辞分化，破坏泛解析收敛）
    expect(tool.description).toContain("question is optional")
    expect(tool.description).not.toContain("be specific")
    const qDesc = String(tool.args["question"]["description"])
    expect(qDesc).toContain("Optional")
  })

  test("描述路径：创建子会话调用视觉模型并返回描述，子会话用后即删", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })

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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    // R2：运行中用户 abort → 先 abort 再删除该子会话
    expect(client.calls.aborted).toEqual(["ses_sub_1"])
    expect(client.calls.deleted).toContain("ses_sub_1")
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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

  test("中止传导：pre-abort → 不发起 URL 下载", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    let fetched = 0
    const restore = mockFetch((async () => {
      fetched += 1
      return new Response(TINY_PNG)
    }) as typeof fetch)
    try {
      const controller = new AbortController()
      controller.abort()
      const result = await getAnalyze(hooks)(
        { image_path: "http://example.com/pic.png", question: "x" },
        toolCtx(controller.signal),
      )
      // 已中止则根本不发请求；下载失败文字透传 Aborted
      expect(fetched).toBe(0)
      expect(result.output).toContain("Image download failed: Aborted")
    } finally {
      restore()
    }
  })

  test("中止传导：下载进行中 abort → 立即中断请求", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    let fetchSignal: AbortSignal | undefined
    const restore = mockFetch(((_, init) => {
      fetchSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )
      })
    }) as typeof fetch)
    try {
      const controller = new AbortController()
      const pending = getAnalyze(hooks)(
        { image_path: "http://example.com/pic.png", question: "x" },
        toolCtx(controller.signal),
      )
      // 等 fetch 已被调用、signal 已传入下载请求
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fetchSignal).toBeDefined()
      controller.abort()
      const result = await pending

      // abort 传导到下载请求：signal 已中止、结果透传 Aborted、不建子会话
      expect(fetchSignal?.aborted).toBe(true)
      expect(result.output).toContain("Image download failed: Aborted")
      expect(client.calls.create.length).toBe(0)
    } finally {
      restore()
    }
  })
})

describe("超时 / 中止 / 容错", () => {
  test("R1：providers 能力查询挂起 → 超时降级（不永久 stall、不注入 hint、空链 memoize）", async () => {
    const client = makeStubClient()
    // providers 永不 resolve：模拟能力查询挂起
    client.setProvidersResult(() => new Promise(() => {}))
    const original = providersTimeout.ms
    providersTimeout.ms = 25
    try {
      const { hooks } = await loadPlugin(makePluginInput(dir, client), {} as PluginOptions) // auto 模式
      const out = chatOutput([imagePart()])
      const started = Date.now()
      // model 缺省（等价 SDK/TUI 首条消息）：递归防护与能力门控都不查询，只走 resolveChain 一次
      await hooks["chat.message"](chatInput({ sessionID: "ses_1" }), out)
      const elapsed = Date.now() - started

      // 空链降级：不注入 hint
      const hintTexts = out.parts
        .map((p) => (p as { text?: string }).text)
        .filter((t): t is string => typeof t === "string" && t.includes("vision_analyze"))
      expect(hintTexts).toHaveLength(0)
      // 超时降级而非永久挂起：等满超时后正常返回
      expect(elapsed).toBeGreaterThanOrEqual(20)
      expect(elapsed).toBeLessThan(1000)
      expect(client.calls.providers).toBe(1)

      // 第二次同消息：空链被 memoize → 不再发起 providers 查询、不 stall
      const out2 = chatOutput([imagePart()])
      await hooks["chat.message"](chatInput({ sessionID: "ses_1" }), out2)
      expect(client.calls.providers).toBe(1)
      const hintTexts2 = out2.parts
        .map((p) => (p as { text?: string }).text)
        .filter((t): t is string => typeof t === "string" && t.includes("vision_analyze"))
      expect(hintTexts2).toHaveLength(0)
    } finally {
      providersTimeout.ms = original
    }
  })

  test("超时：timeout_ms 到期后返回超时错误并清理子会话", async () => {
    const client = makeStubClient()
    client.setPromptBehavior(() => new Promise(() => {}))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model"],
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

  test("R2：超时路径先 abort 子会话再 delete（取消孤儿回合）", async () => {
    const client = makeStubClient()
    client.setPromptBehavior(() => new Promise(() => {}))
    // 本地记录 abort/delete 的先后顺序（stub 默认实现只分别入列，无法跨数组断言顺序）
    const order: string[] = []
    const rawAbort = client.session.abort.bind(client.session)
    const rawDelete = client.session.delete.bind(client.session)
    client.session.abort = async (args: { path: { id: string } }) => {
      order.push(`abort:${args.path.id}`)
      return rawAbort(args)
    }
    client.session.delete = async (args: { path: { id: string } }) => {
      order.push(`delete:${args.path.id}`)
      return rawDelete(args)
    }

    const { hooks } = await loadPlugin(makePluginInput(dir, client), {
      models: ["test/vision-model"],
      timeout_ms: 10,
    })
    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
    const result = await getAnalyze(hooks)(
      { image_path: persistedPath(), question: "x" },
      toolCtx(new AbortController().signal),
    )

    expect(result.output).toContain("vision model call timed out after 10ms")
    expect(client.calls.aborted).toContain("ses_sub_1")
    expect(client.calls.deleted).toContain("ses_sub_1")
    expect(order).toEqual(["abort:ses_sub_1", "delete:ses_sub_1"])
  })

  test("R2：成功路径不 abort 子会话", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)

    const result = await getAnalyze(hooks)(
      { image_path: persistedPath(), question: "x" },
      toolCtx(new AbortController().signal),
    )
    expect(result.output).toContain("described by test/vision-model")
    expect(client.calls.deleted).toContain("ses_sub_1")
    expect(client.calls.aborted).toHaveLength(0)
  })

  test("预先中止的 signal：立即以 Aborted 结束", async () => {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
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
      models: ["test/vision-model"],
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

describe("图片缓存（恒用户级目录 + LRU/容量）", () => {
  /** 图片缓存目录：cacheHome/opencode-vision-analyze/vision（Linux，XDG_CACHE_HOME 已由 beforeEach 注入）。 */
  /** 由种子构造长度固定、内容可判别的图片字节（扩展名 .png，仅供落盘/加载，不解析像素）。 */
  function bytesOf(seed: number, size = 700): Buffer {
    const b = Buffer.alloc(size)
    for (let i = 0; i < size; i++) b[i] = (seed * 31 + i) % 251
    return b
  }
  const shaOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const imgPathOf = (bytes: Buffer) => path.join(visionDir(), `${shaOf(bytes)}.png`)
  /** 构造给定字节的图片 file part（data URL，模拟贴图）。 */
  function partOf(bytes: Buffer): Record<string, unknown> {
    return {
      id: `prt_${shaOf(bytes).slice(0, 12)}`,
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "file",
      mime: "image/png",
      url: `data:image/png;base64,${bytes.toString("base64")}`,
      filename: "img.png",
    }
  }
  /** 经 chat.message 钩子「贴」一张图（无视觉主模型 → 落盘 + 注入 hint），返回注入后的 hint。 */
  async function paste(client: StubClient, hooks: LoadedPlugin["hooks"], bytes: Buffer): Promise<string> {
    const out = chatOutput([partOf(bytes)])
    await hooks["chat.message"](chatInput({ sessionID: "ses_1", model: MAIN_MODEL }), out)
    const hint = out.parts[out.parts.length - 1] as { text?: string }
    return hint.text ?? ""
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function loadWithVision(): Promise<{ client: StubClient; hooks: LoadedPlugin["hooks"] }> {
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    return { client, hooks }
  }

  test("userVisionCacheRoot：三平台默认 + env 覆盖 + 空串回退（恒用户级）", () => {
    // Linux：默认 ~/.cache
    expect(userVisionCacheRoot({}, "linux", "/home/u")).toBe(
      path.join("/home/u", ".cache", "opencode-vision-analyze", "vision"),
    )
    // Linux + XDG_CACHE_HOME 覆盖
    expect(userVisionCacheRoot({ XDG_CACHE_HOME: "/x/cache" }, "linux", "/home/u")).toBe(
      path.join("/x/cache", "opencode-vision-analyze", "vision"),
    )
    // macOS：~/Library/Caches
    expect(userVisionCacheRoot({}, "darwin", "/Users/u")).toBe(
      path.join("/Users/u", "Library", "Caches", "opencode-vision-analyze", "vision"),
    )
    // macOS + XDG 覆盖（跨平台 dotfiles 宽容超集）
    expect(userVisionCacheRoot({ XDG_CACHE_HOME: "/x/cache" }, "darwin", "/Users/u")).toBe(
      path.join("/x/cache", "opencode-vision-analyze", "vision"),
    )
    // Windows：LOCALAPPDATA 覆盖 + 默认 ~/AppData/Local
    expect(userVisionCacheRoot({ LOCALAPPDATA: "C:\\lapp" }, "win32", "C:\\Users\\u")).toBe(
      path.join("C:\\lapp", "opencode-vision-analyze", "vision"),
    )
    expect(userVisionCacheRoot({}, "win32", "C:\\Users\\u")).toBe(
      path.join("C:\\Users\\u", "AppData", "Local", "opencode-vision-analyze", "vision"),
    )
    // 空串 env 视为未设置 → 回退默认
    expect(userVisionCacheRoot({ XDG_CACHE_HOME: "" }, "linux", "/home/u")).toBe(
      path.join("/home/u", ".cache", "opencode-vision-analyze", "vision"),
    )
    expect(userVisionCacheRoot({ LOCALAPPDATA: "" }, "win32", "C:\\Users\\u")).toBe(
      path.join("C:\\Users\\u", "AppData", "Local", "opencode-vision-analyze", "vision"),
    )
    // 与描述缓存同根同级：dirname 相等（两套缓存并列于 opencode-vision-analyze/ 下）
    expect(path.dirname(userVisionCacheRoot({}, "linux", "/home/u"))).toBe(
      path.dirname(resolveDescriptionDir({}, "linux", "/home/u")),
    )
  })

  test("端到端（git 项目目录）：贴图落用户级 vision 目录，项目目录零污染", async () => {
    // 显式模拟 git 项目（.git 目录），证明图片存储与 git 判定解耦、不再写项目内
    await mkdir(path.join(dir, ".git"))
    const { client, hooks } = await loadWithVision()
    const hint = await paste(client, hooks, TINY_PNG)
    expect(hint).toContain("vision_analyze")
    expect(hint).toContain(`image_path: ${persistedPath()}`)
    expect(await fileExists(persistedPath())).toBe(true)
    // 项目目录零污染：不产生任何 .opencode 运行时产物
    expect(await fileExists(path.join(dir, ".opencode"))).toBe(false)
  })

  test("并发写同一 sha：最终文件字节完整、无残留临时文件", async () => {
    const { client, hooks } = await loadWithVision()
    const images = [partOf(TINY_PNG), partOf(TINY_PNG)] // 同字节同 sha
    const outA = chatOutput([images[0]])
    const outB = chatOutput([images[1]])
    const hook = hooks["chat.message"]
    await Promise.all([
      hook(chatInput({ sessionID: "ses_a", model: MAIN_MODEL }), outA),
      hook(chatInput({ sessionID: "ses_b", model: MAIN_MODEL }), outB),
    ])

    const bytes = await readFile(persistedPath())
    expect(bytes.equals(TINY_PNG)).toBe(true)
    const files = await readdir(visionDir())
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0)
  })

  test("落盘失败路径：清理孤儿临时文件，fail-open 不注入 hint", async () => {
    // 目标同名目录已存在且非空 → rename(tmp, <sha>.png) 失败，触发 helper 的 tmp 清理。
    const clash = persistedPath()
    await mkdir(clash, { recursive: true })
    await writeFile(path.join(clash, "occupied"), "x")

    const { client, hooks } = await loadWithVision()
    const hint = await paste(client, hooks, TINY_PNG)
    // fail-open：消息不落库失败；未注入 hint；无 .tmp-* 孤儿残留。
    expect(hint).toBe("")
    const files = await readdir(visionDir())
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0)
  })

  test("LRU 条目上限：maxEntries=2 贴 3 张不同图 → 最旧被淘汰，目录只剩 2", async () => {
    const saved = { ...visionCacheLimits }
    visionCacheLimits.maxEntries = 2
    visionCacheLimits.maxBytes = 500 * 1024 * 1024 // 条目维度隔离：字节上限放大
    const { client, hooks } = await loadWithVision()
    try {
      const a = bytesOf(1)
      const b = bytesOf(2)
      const c = bytesOf(3)
      for (const img of [a, b, c]) {
        await paste(client, hooks, img)
        await sleep(10) // 拉开 mtime，保证淘汰顺序可判
      }
      // 容量：目录只剩 2 张（最早写入的 a 被逐出）
      const files = (await readdir(visionDir())).filter((f) => f.endsWith(".png"))
      expect(files.length).toBe(2)
      expect(await fileExists(imgPathOf(a))).toBe(false)
      expect(await fileExists(imgPathOf(b))).toBe(true)
      expect(await fileExists(imgPathOf(c))).toBe(true)
    } finally {
      visionCacheLimits.maxEntries = saved.maxEntries
      visionCacheLimits.maxBytes = saved.maxBytes
    }
  })

  test("LRU 字节上限：maxBytes=1500 贴 3 张（各 700B）→ 淘汰最旧至总字节 ≤ 1500", async () => {
    const saved = { ...visionCacheLimits }
    visionCacheLimits.maxEntries = 2000
    visionCacheLimits.maxBytes = 1500
    const { client, hooks } = await loadWithVision()
    try {
      const a = bytesOf(1)
      const b = bytesOf(2)
      const c = bytesOf(3)
      for (const img of [a, b, c]) {
        await paste(client, hooks, img)
        await sleep(10)
      }
      // 3×700=2100 > 1500 → 淘汰 1 条 → 2×700=1400 ≤ 1500
      const files = (await readdir(visionDir())).filter((f) => f.endsWith(".png"))
      expect(files.length).toBe(2)
      const total = (
        await Promise.all(files.map(async (f) => (await stat(path.join(visionDir(), f))).size)),
      ).reduce((x, y) => x + y, 0)
      expect(total).toBeLessThanOrEqual(1500)
      expect(await fileExists(imgPathOf(a))).toBe(false)
      expect(await fileExists(imgPathOf(b))).toBe(true)
      expect(await fileExists(imgPathOf(c))).toBe(true)
    } finally {
      visionCacheLimits.maxEntries = saved.maxEntries
      visionCacheLimits.maxBytes = saved.maxBytes
    }
  })

  test("单图超限：maxBytes=100 贴 300B 图 → 仍落盘且当次不被自删，下一次写入才收敛", async () => {
    const saved = { ...visionCacheLimits }
    visionCacheLimits.maxEntries = 2000
    visionCacheLimits.maxBytes = 100
    const { client, hooks } = await loadWithVision()
    try {
      const big = bytesOf(9, 300)
      // 单图 > maxBytes：稳定 image_path 必需 → 允许落盘；protect 保证当次不被自己的淘汰删除
      await paste(client, hooks, big)
      expect(await fileExists(imgPathOf(big))).toBe(true)

      // 下一次无关写入（TINY_PNG 68B）触发淘汰 → 超限巨图成为最旧被收敛，新图保留
      await sleep(10)
      await paste(client, hooks, TINY_PNG)
      expect(await fileExists(imgPathOf(big))).toBe(false)
      expect(await fileExists(persistedPath())).toBe(true)
    } finally {
      visionCacheLimits.maxEntries = saved.maxEntries
      visionCacheLimits.maxBytes = saved.maxBytes
    }
  })

  test("LRU touch：命中缓存内旧图延寿（touch 后不再是淘汰对象）", async () => {
    const saved = { ...visionCacheLimits }
    visionCacheLimits.maxEntries = 2
    visionCacheLimits.maxBytes = 500 * 1024 * 1024
    const { client, hooks } = await loadWithVision()
    try {
      const a = bytesOf(1)
      const b = bytesOf(2)
      await paste(client, hooks, a)
      await sleep(10)
      await paste(client, hooks, b)
      await sleep(10)

      // 经工具命中 a（vision 缓存根内）→ loadImage touch a → a 成为最新，b 反而最旧
      const r = await getAnalyze(hooks)(
        { image_path: imgPathOf(a), question: "look" },
        toolCtx(new AbortController().signal),
      )
      expect(r.title).toBe("vision_analyze")
      await sleep(10)

      // 再写一张 c → 淘汰最旧：应淘汰 b（未被 touch），a 因 touch 延寿保留
      await paste(client, hooks, bytesOf(3))
      expect(await fileExists(imgPathOf(a))).toBe(true)
      expect(await fileExists(imgPathOf(b))).toBe(false)
    } finally {
      visionCacheLimits.maxEntries = saved.maxEntries
      visionCacheLimits.maxBytes = saved.maxBytes
    }
  })

  test("流程 B 外部本地文件：原位读取、绝不 touch（mtime 不变）", async () => {
    const ext = path.join(dir, "external.png")
    await writeFile(ext, TINY_PNG)
    const before = await stat(ext)
    const { hooks } = await loadWithVision()
    const r = await getAnalyze(hooks)(
      { image_path: ext, question: "what is this?" },
      toolCtx(new AbortController().signal),
    )
    expect(r.output).toContain("a red square")
    const after = await stat(ext)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    // 且未在 vision 缓存目录产生任何复制
    expect(await fileExists(persistedPath())).toBe(false)
  })
})

describe("描述缓存落盘持久化（用户级目录 + LRU/容量）", () => {
  /** 描述缓存目录：cacheHome/opencode-vision-analyze/descriptions（Linux，XDG_CACHE_HOME 已由 beforeEach 注入）。 */
  const descDir = () => path.join(cacheHome, "opencode-vision-analyze", "descriptions")
  /** 给定 question 的缓存条目文件路径（key = TINY_PNG_SHA:question 的 sha256 命名）。 */
  const descPath = (question: string) =>
    path.join(descDir(), `${createHash("sha256").update(`${TINY_PNG_SHA}:${question}`).digest("hex")}.json`)
  /** 写入测试图片到项目 vision 目录（供 loadImage）。 */
  async function seedImage(): Promise<void> {
    await mkdir(path.dirname(persistedPath()), { recursive: true })
    await writeFile(persistedPath(), TINY_PNG)
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test("resolveDescriptionDir：三平台默认 + env 覆盖 + 空串回退（与 git 无关恒用户级）", () => {
    // Linux：默认 ~/.cache
    expect(resolveDescriptionDir({}, "linux", "/home/u")).toBe(
      path.join("/home/u", ".cache", "opencode-vision-analyze", "descriptions"),
    )
    // Linux + XDG_CACHE_HOME 覆盖
    expect(resolveDescriptionDir({ XDG_CACHE_HOME: "/x/cache" }, "linux", "/home/u")).toBe(
      path.join("/x/cache", "opencode-vision-analyze", "descriptions"),
    )
    // macOS：~/Library/Caches
    expect(resolveDescriptionDir({}, "darwin", "/Users/u")).toBe(
      path.join("/Users/u", "Library", "Caches", "opencode-vision-analyze", "descriptions"),
    )
    // macOS + XDG 覆盖
    expect(resolveDescriptionDir({ XDG_CACHE_HOME: "/x/cache" }, "darwin", "/Users/u")).toBe(
      path.join("/x/cache", "opencode-vision-analyze", "descriptions"),
    )
    // Windows：LOCALAPPDATA 覆盖 + 默认 ~/AppData/Local
    expect(resolveDescriptionDir({ LOCALAPPDATA: "C:\\lapp" }, "win32", "C:\\Users\\u")).toBe(
      path.join("C:\\lapp", "opencode-vision-analyze", "descriptions"),
    )
    expect(resolveDescriptionDir({}, "win32", "C:\\Users\\u")).toBe(
      path.join("C:\\Users\\u", "AppData", "Local", "opencode-vision-analyze", "descriptions"),
    )
    // 空串 env 视为未设置 → 回退默认
    expect(resolveDescriptionDir({ XDG_CACHE_HOME: "" }, "linux", "/home/u")).toBe(
      path.join("/home/u", ".cache", "opencode-vision-analyze", "descriptions"),
    )
    expect(resolveDescriptionDir({ LOCALAPPDATA: "" }, "win32", "C:\\Users\\u")).toBe(
      path.join("C:\\Users\\u", "AppData", "Local", "opencode-vision-analyze", "descriptions"),
    )
  })

  test("命中持久化：第一实例写盘 → 第二独立实例（同缓存目录）直接命中、不再调视觉模型", async () => {
    await seedImage()
    const clientA = makeStubClient()
    const { hooks: hooksA } = await loadPlugin(makePluginInput(dir, clientA), { models: ["test/vision-model"] })
    const analyzeA = getAnalyze(hooksA)

    const first = await analyzeA(
      { image_path: persistedPath(), question: "persist me" },
      toolCtx(new AbortController().signal),
    )
    expect(first.title).toBe("vision_analyze")
    expect(clientA.calls.prompt.length).toBe(1)
    // 描述落盘到用户级缓存目录（git 项目也落用户级，不落项目内）
    expect(await fileExists(descPath("persist me"))).toBe(true)

    // 第二实例：全新闭包（无进程内缓存），共享同一 XDG_CACHE_HOME → 磁盘命中
    const clientB = makeStubClient()
    const { hooks: hooksB } = await loadPlugin(makePluginInput(dir, clientB), { models: ["test/vision-model"] })
    const analyzeB = getAnalyze(hooksB)
    const second = await analyzeB(
      { image_path: persistedPath(), question: "persist me" },
      toolCtx(new AbortController().signal),
    )
    expect(second.title).toBe("vision_analyze (cached)")
    expect(second.output).toContain("a red square")
    expect(clientB.calls.prompt.length).toBe(0)
  })

  test("命中沿用入库 modelId：磁盘条目由 other-vision 产出，新实例命中标签仍为 other-vision", async () => {
    await seedImage()
    // 实例 A：链首 vision-model 失败 → other-vision 成功并入库（磁盘）
    const clientA = makeStubClient()
    clientA.setPromptBehavior((model) =>
      model?.modelID === "vision-model"
        ? { error: new Error("boom for vision") }
        : { data: { parts: [{ type: "text", text: "described by other" }] } },
    )
    const { hooks: hooksA } = await loadPlugin(makePluginInput(dir, clientA), {
      models: ["test/vision-model", "test/other-vision"],
    } as PluginOptions)
    const analyzeA = getAnalyze(hooksA)
    await analyzeA(
      { image_path: persistedPath(), question: "who labels" },
      toolCtx(new AbortController().signal),
    )
    expect(clientA.calls.prompt.length).toBe(2)
    expect(await fileExists(descPath("who labels"))).toBe(true)

    // 实例 B：默认行为（若真的调模型会用链首 vision-model 标签），磁盘命中应沿用 other-vision
    const clientB = makeStubClient()
    const { hooks: hooksB } = await loadPlugin(makePluginInput(dir, clientB), { models: ["test/vision-model"] })
    const analyzeB = getAnalyze(hooksB)
    const hit = await analyzeB(
      { image_path: persistedPath(), question: "who labels" },
      toolCtx(new AbortController().signal),
    )
    expect(hit.title).toBe("vision_analyze (cached)")
    expect(hit.output).toContain("described by test/other-vision")
    expect(hit.output).toContain("described by other")
    expect(clientB.calls.prompt.length).toBe(0)
  })

  test("LRU 条目上限：maxEntries=2 写 3 条 → 最旧条目被淘汰，目录只剩 2 条且最旧再问为 miss", async () => {
    await seedImage()
    const saved = { ...descriptionCacheLimits }
    descriptionCacheLimits.maxEntries = 2
    descriptionCacheLimits.maxBytes = 50 * 1024 * 1024 // 条目维度隔离：字节上限放大
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)
    try {
      const questions = ["q1", "q2", "q3"]
      for (const q of questions) {
        const r = await analyze({ image_path: persistedPath(), question: q }, toolCtx(new AbortController().signal))
        expect(r.title).toBe("vision_analyze")
        await sleep(10) // 拉开 mtime，保证淘汰顺序可判
      }
      // 容量：目录只剩 2 个条目（q1 被逐出）
      const files = await readdir(descDir())
      expect(files.filter((f) => f.endsWith(".json")).length).toBe(2)
      expect(await fileExists(descPath("q1"))).toBe(false)
      expect(await fileExists(descPath("q2"))).toBe(true)
      expect(await fileExists(descPath("q3"))).toBe(true)

      // 最旧（q1）再问 → miss，重新调用视觉模型
      const promptsBefore = client.calls.prompt.length
      const again = await analyze({ image_path: persistedPath(), question: "q1" }, toolCtx(new AbortController().signal))
      expect(again.title).toBe("vision_analyze")
      expect(client.calls.prompt.length).toBe(promptsBefore + 1)
    } finally {
      descriptionCacheLimits.maxEntries = saved.maxEntries
      descriptionCacheLimits.maxBytes = saved.maxBytes
    }
  })

  test("LRU 字节上限：maxBytes=500 写 3 条（各 ~242B）→ 淘汰最旧至总字节 ≤ 500", async () => {
    await seedImage()
    const saved = { ...descriptionCacheLimits }
    descriptionCacheLimits.maxBytes = 500
    const client = makeStubClient()
    // 固定长描述（200 字符 → 单条 JSON ~242B），便于字节预算可判
    client.setPromptBehavior(async () => ({ data: { parts: [{ type: "text", text: "x".repeat(200) }] } }))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)
    try {
      for (const q of ["b1", "b2", "b3"]) {
        const r = await analyze({ image_path: persistedPath(), question: q }, toolCtx(new AbortController().signal))
        expect(r.title).toBe("vision_analyze")
        await sleep(10)
      }
      // 3×242=726 > 500 → 淘汰 1 条 → 2×242=484 ≤ 500
      const files = (await readdir(descDir())).filter((f) => f.endsWith(".json"))
      expect(files.length).toBe(2)
      const total = (
        await Promise.all(
          files.map(async (f) => (await stat(path.join(descDir(), f))).size),
        )
      ).reduce((a, b) => a + b, 0)
      expect(total).toBeLessThanOrEqual(500)
      // 最旧 b1 已淘汰；最新 b3 仍命中
      expect(await fileExists(descPath("b1"))).toBe(false)
      const promptsBefore = client.calls.prompt.length
      const hit = await analyze({ image_path: persistedPath(), question: "b3" }, toolCtx(new AbortController().signal))
      expect(hit.title).toBe("vision_analyze (cached)")
      expect(client.calls.prompt.length).toBe(promptsBefore)
    } finally {
      descriptionCacheLimits.maxBytes = saved.maxBytes
      descriptionCacheLimits.maxEntries = saved.maxEntries
    }
  })

  test("单条超限不入缓存（A 策略）：不落盘、正常返回文本、其它条目原封不动", async () => {
    await seedImage()
    const saved = { ...descriptionCacheLimits }
    descriptionCacheLimits.maxBytes = 500
    descriptionCacheLimits.maxEntries = 2000
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)
    try {
      // 先写一条正常条目（~"a red square" 数十 B，远小于 cap）
      const normal = await analyze(
        { image_path: persistedPath(), question: "small" },
        toolCtx(new AbortController().signal),
      )
      expect(normal.title).toBe("vision_analyze")
      expect(await fileExists(descPath("small"))).toBe(true)

      // 换超大描述（单条 JSON >> maxBytes）→ 预检拒绝入缓存
      client.setPromptBehavior(async () => ({ data: { parts: [{ type: "text", text: "y".repeat(5000) }] } }))
      const big = await analyze(
        { image_path: persistedPath(), question: "huge" },
        toolCtx(new AbortController().signal),
      )
      // 描述照常返回（缓存只是 best-effort），但该 key 不落盘
      expect(big.output).toContain("yyyyy")
      expect(await fileExists(descPath("huge"))).toBe(false)
      // 缓存目录中正常条目不被冲掉、总量仍在 cap 内
      expect(await fileExists(descPath("small"))).toBe(true)
      const files = (await readdir(descDir())).filter((f) => f.endsWith(".json"))
      expect(files.length).toBe(1)
      const total = (await stat(path.join(descDir(), files[0]))).size
      expect(total).toBeLessThanOrEqual(500)
    } finally {
      descriptionCacheLimits.maxBytes = saved.maxBytes
      descriptionCacheLimits.maxEntries = saved.maxEntries
    }
  })

  test("并发写同 key（两个实例）：文件完整、无 .tmp-* 孤儿", async () => {
    await seedImage()
    const make = () => makeStubClient()
    const { hooks: hooks1 } = await loadPlugin(makePluginInput(dir, make()), { models: ["test/vision-model"] })
    const { hooks: hooks2 } = await loadPlugin(makePluginInput(dir, make()), { models: ["test/vision-model"] })
    const args = { image_path: persistedPath(), question: "concurrent" } as const
    await Promise.all([
      getAnalyze(hooks1)(args, toolCtx(new AbortController().signal)),
      getAnalyze(hooks2)(args, toolCtx(new AbortController().signal)),
    ])
    // 内容寻址原子写：最终文件完整可解析
    const bytes = await readFile(descPath("concurrent"))
    const parsed = JSON.parse(bytes.toString("utf8")) as { modelId: string; text: string }
    expect(typeof parsed.modelId).toBe("string")
    expect(parsed.text.length).toBeGreaterThan(0)
    const files = await readdir(descDir())
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0)
  })

  test("损坏 JSON → 当 miss：正常重描述并覆盖回合法内容", async () => {
    await seedImage()
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)
    const target = descPath("corrupt")
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, "not-json{{{")

    const result = await analyze(
      { image_path: persistedPath(), question: "corrupt" },
      toolCtx(new AbortController().signal),
    )
    expect(result.title).toBe("vision_analyze")
    expect(result.output).toContain("a red square")
    expect(client.calls.prompt.length).toBe(1)
    // 写回覆盖成合法 JSON
    const bytes = await readFile(target)
    expect(JSON.parse(bytes.toString("utf8"))).toHaveProperty("text")
  })

  test("写失败 fail-open：目标为同名非空目录 → rename 失败，工具仍返回文本、无 tmp 孤儿、不抛错", async () => {
    await seedImage()
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)
    // 预先在目标条目路径放一个非空目录 → store 的 rename(tmp, target) 失败
    const clash = descPath("clash")
    await mkdir(clash, { recursive: true })
    await writeFile(path.join(clash, "occupied"), "x")

    const result = await analyze(
      { image_path: persistedPath(), question: "clash" },
      toolCtx(new AbortController().signal),
    )
    // 描述成功照常返回（缓存写失败是 best-effort，不阻断工具）
    expect(result.output).toContain("a red square")
    expect(client.calls.prompt.length).toBe(1)
    const files = await readdir(descDir())
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0)
  })

  // ---- 泛解析 canonical key：省略/空/措辞变体收敛到同一条，跨会话命中 ----

  /** 一段足够长的描述（超过泛解析写入门槛 100 字符），供需要落盘的用例注入。 */
  const LONG_TEXT = "complete description of the dashboard with a red square in the center and a blue circle on the right. ".repeat(3)

  test("isGenericQuestion：空串与 canonical 变体判泛解析，具体追问不判", () => {
    // 泛解析：空 / 纯空白 / 原文 / 大小写+引号 / 全角引号 / 缺句末标点
    expect(isGenericQuestion("")).toBe(true)
    expect(isGenericQuestion("   ")).toBe(true)
    expect(isGenericQuestion(GENERIC_QUESTION)).toBe(true)
    expect(
      isGenericQuestion(
        '  "Describe This Image In Full Detail, Including All Text, UI Elements, Diagrams, Or Content Visible."  ',
      ),
    ).toBe(true)
    expect(
      isGenericQuestion(
        "「describe this image in full detail, including all text, ui elements, diagrams, or content visible」",
      ),
    ).toBe(true)
    expect(
      isGenericQuestion(
        "Describe this image in full detail, including all text, UI elements, diagrams, or content visible",
      ),
    ).toBe(true)
    expect(
      isGenericQuestion(
        "describe this image in full detail, including all text, ui elements, diagrams, or content visible?",
      ),
    ).toBe(true)
    expect(
      isGenericQuestion(
        "describe\u3000this\u3000image\u3000in\u3000full\u3000detail,\u3000including\u3000all\u3000text,\u3000ui\u3000elements,\u3000diagrams,\u3000or\u3000content\u3000visible",
      ),
    ).toBe(true)
    // 具体追问：既有用例用词、针对性问句、带 canonical 句子的追问都不能误判为泛解析
    expect(isGenericQuestion("persist me")).toBe(false)
    expect(isGenericQuestion("who labels")).toBe(false)
    expect(isGenericQuestion("what color is the logo?")).toBe(false)
    expect(
      isGenericQuestion(
        "Describe this image in full detail, including all text, UI elements, diagrams, or content visible, and read the error inside the red box.",
      ),
    ).toBe(false)
  })

  test("normalizeQuestion：去首尾引号括号、折叠空白、统一大小写、去句末标点", () => {
    expect(
      normalizeQuestion("  Describe  This   Image in full detail, including ALL Text, UI Elements, diagrams, or content visible. "),
    ).toBe("describe this image in full detail, including all text, ui elements, diagrams, or content visible")
    expect(normalizeQuestion("「解析图片」")).toBe("解析图片")
    expect(
      normalizeQuestion(
        "describe this image\nin full detail, including all text, ui elements, diagrams, or content visible!",
      ),
    ).toBe("describe this image in full detail, including all text, ui elements, diagrams, or content visible")
  })

  test("泛解析省略 question：落 GENERIC_QUESTION 单条；显式 canonical 与措辞变体跨实例命中", async () => {
    await seedImage()
    const clientA = makeStubClient()
    clientA.setPromptBehavior(async () => ({ data: { parts: [{ type: "text", text: LONG_TEXT }] } }))
    const { hooks: hooksA } = await loadPlugin(makePluginInput(dir, clientA), { models: ["test/vision-model"] })
    const analyzeA = getAnalyze(hooksA)

    // 实例A：主模型对“解析图片”不填 question（省略）→ 走默认 canonical，落一条固定 key
    const first = await analyzeA({ image_path: persistedPath() }, toolCtx(new AbortController().signal))
    expect(first.title).toBe("vision_analyze")
    expect(clientA.calls.prompt.length).toBe(1)
    // 发给视觉子会话的问题就是 canonical 原文（不是空串/自编措辞）
    const parts = clientA.calls.prompt[0]?.parts as Array<Record<string, unknown>>
    expect(parts.some((p) => p["type"] === "text" && p["text"] === GENERIC_QUESTION)).toBe(true)
    expect(await fileExists(descPath(GENERIC_QUESTION))).toBe(true)

    // 实例B：显式传 canonical → 命中
    const clientB = makeStubClient()
    const { hooks: hooksB } = await loadPlugin(makePluginInput(dir, clientB), { models: ["test/vision-model"] })
    const second = await getAnalyze(hooksB)(
      { image_path: persistedPath(), question: GENERIC_QUESTION },
      toolCtx(new AbortController().signal),
    )
    expect(second.title).toBe("vision_analyze (cached)")
    expect(clientB.calls.prompt.length).toBe(0)

    // 实例C：措辞变体（大小写/引号/多余空白）→ 归一化后同样命中
    const clientC = makeStubClient()
    const { hooks: hooksC } = await loadPlugin(makePluginInput(dir, clientC), { models: ["test/vision-model"] })
    const third = await getAnalyze(hooksC)(
      {
        image_path: persistedPath(),
        question: '  "DESCRIBE THIS IMAGE IN FULL DETAIL, INCLUDING ALL TEXT, UI ELEMENTS, DIAGRAMS, OR CONTENT VISIBLE"  ',
      },
      toolCtx(new AbortController().signal),
    )
    expect(third.title).toBe("vision_analyze (cached)")
    expect(clientC.calls.prompt.length).toBe(0)
  })

  test("磁盘已有 canonical 条目时：省略 question 直接命中（key 固定，不重复描述）", async () => {
    await seedImage()
    // 预置一条 GENERIC_QUESTION 键的条目（等价于此前任意一次泛解析落盘产物）
    await mkdir(descDir(), { recursive: true })
    await writeFile(
      descPath(GENERIC_QUESTION),
      JSON.stringify({ modelId: "test/other-vision", text: "legacy full description of the dashboard" }),
    )
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const hit = await getAnalyze(hooks)({ image_path: persistedPath() }, toolCtx(new AbortController().signal))
    expect(hit.title).toBe("vision_analyze (cached)")
    expect(hit.output).toContain("legacy full description")
    expect(client.calls.prompt.length).toBe(0)
  })

  test("泛解析与具体追问并存：各写各的 key，重复具体追问与重复泛解析均各自命中", async () => {
    await seedImage()
    const client = makeStubClient()
    client.setPromptBehavior(async () => ({ data: { parts: [{ type: "text", text: LONG_TEXT }] } }))
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)

    // 先泛解析（省略）→ 写 canonical 条目
    const generic = await analyze({ image_path: persistedPath() }, toolCtx(new AbortController().signal))
    expect(generic.title).toBe("vision_analyze")
    expect(await fileExists(descPath(GENERIC_QUESTION))).toBe(true)

    // 具体追问 → 写自己的精确条目（key 与旧格式 sha:question 一致）
    const targetedQ = "what color is the logo in the top-left corner?"
    const targeted = await analyze(
      { image_path: persistedPath(), question: targetedQ },
      toolCtx(new AbortController().signal),
    )
    expect(targeted.title).toBe("vision_analyze")
    expect(await fileExists(descPath(targetedQ))).toBe(true)

    // 各自重复 → 各自命中，互不串用
    const again = await analyze(
      { image_path: persistedPath(), question: targetedQ },
      toolCtx(new AbortController().signal),
    )
    expect(again.title).toBe("vision_analyze (cached)")
    const genericAgain = await analyze({ image_path: persistedPath() }, toolCtx(new AbortController().signal))
    expect(genericAgain.title).toBe("vision_analyze (cached)")
    const files = (await readdir(descDir())).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(2)
  })

  test("泛解析短文本不落盘（防毒化），具体追问短答案不受限", async () => {
    await seedImage()
    const saved = genericWriteMinText.chars
    genericWriteMinText.chars = 100
    const client = makeStubClient()
    const { hooks } = await loadPlugin(makePluginInput(dir, client), { models: ["test/vision-model"] })
    const analyze = getAnalyze(hooks)
    try {
      // 泛解析 + 视觉模型敷衍返回极短文本 → 文本照常返回但不落盘
      client.setPromptBehavior(async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }))
      const g = await analyze({ image_path: persistedPath() }, toolCtx(new AbortController().signal))
      expect(g.title).toBe("vision_analyze")
      expect(g.output).toContain("ok")
      expect(await fileExists(descPath(GENERIC_QUESTION))).toBe(false)

      // 具体追问 + 同样短文本（短答案合法）→ 允许落盘
      client.setPromptBehavior(async () => ({ data: { parts: [{ type: "text", text: "42" }] } }))
      const t = await analyze(
        { image_path: persistedPath(), question: "how many red squares" },
        toolCtx(new AbortController().signal),
      )
      expect(t.title).toBe("vision_analyze")
      expect(await fileExists(descPath("how many red squares"))).toBe(true)
    } finally {
      genericWriteMinText.chars = saved
    }
  })
})

