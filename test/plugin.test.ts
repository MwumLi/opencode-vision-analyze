/**
 * opencode-vision-analyze 单元测试。
 *
 * 通过 stub 的插件运行环境（见 helpers.ts）直接调用钩子与工具，
 * 覆盖：导出形状 / 选项校验 / chat.message 门控与落盘 / 能力缓存 /
 * 工具描述路径 / 快速路径 / 描述缓存 / URL 下载与错误路径 / 超时 /
 * 永不抛错 / dispose 清理。
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
  type LoadedPlugin,
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

  test("缺 model 选项或格式非法时抛错", async () => {
    const client = makeStubClient()
    const input = makePluginInput(dir, client)
    await expect(loadPlugin(input, {} as PluginOptions)).rejects.toThrow('requires a "model" option')
    await expect(loadPlugin(input, { model: "no-slash" } as PluginOptions)).rejects.toThrow(
      'requires a "model" option',
    )
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

    expect(result.output).toContain("Image analysis failed: vision model call timed out after 10ms")
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
    expect(result.output).toContain("Image analysis failed: create boom")
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
