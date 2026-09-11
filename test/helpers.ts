/**
 * 测试辅助：构造 stub 的插件运行环境（PluginInput / ToolContext），
 * 让单元测试无需运行中的 opencode 实例。
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import type { PluginInput, PluginOptions, ToolContext } from "@opencode-ai/plugin"

/** 1x1 透明 PNG（68 字节），作为测试图片。 */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
export const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG.toString("base64")}`
export const TINY_PNG_SHA = createHash("sha256").update(TINY_PNG).digest("hex")

/** 临时项目目录（真实落盘可验证）。图片/描述缓存均落用户级缓存根，与目录是否 git 无关。 */
export async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "vision-analyze-test-"))
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** provider/model 引用（与真实钩子入参同形状）。 */
export const modelRef = (providerID: string, modelID: string) => ({ providerID, modelID })

export const MAIN_MODEL = modelRef("test", "text-model") // 无视觉能力
export const VISION_MODEL = modelRef("test", "vision-model") // 插件配置的视觉模型
export const OTHER_VISION_MODEL = modelRef("test", "other-vision") // 有视觉能力但非插件的视觉模型

/** /config/providers 返回的模型能力描述。 */
type StubModel = { capabilities: { input: { image: boolean } } }

/** provider.source 取值：决定自动发现的档位（config > env/api > custom）。 */
export type StubSource = "config" | "env" | "api" | "custom"

/** /config/providers 返回的单个 provider 描述（带 source 供档位排序）。 */
export type StubProvider = { id: string; source: StubSource; models: Record<string, StubModel | undefined> }

export type StubProvidersResult = {
  data?: { providers?: StubProvider[] }
  error?: unknown
}

/**
 * 便捷构造单个 provider stub：models 只需给「modelID → 是否支持图片」，
 * 由本函数补全成 { id, source, models: { <modelID>: { capabilities: { input: { image } } } } }。
 */
export const providerStub = (
  id: string,
  source: StubSource,
  models: Record<string, { image: boolean }>,
): StubProvider => ({
  id,
  source,
  models: Object.fromEntries(
    Object.entries(models).map(([modelID, { image }]) => [
      modelID,
      { capabilities: { input: { image } } },
    ]),
  ),
})

/** 由多个 provider stub 拼成 config.providers() 的返回体。 */
export const providersStub = (...providers: StubProvider[]): StubProvidersResult => ({
  data: { providers },
})

/** session.* 调用记录（断言子会话生命周期时使用）。 */
export type SessionCalls = {
  create: Array<{ parentID?: string; title?: string }>
  prompt: Array<{ id: string; model?: { providerID: string; modelID: string }; parts: unknown[] }>
  deleted: string[]
  /** session.abort 被调用的子会话 id（R2：超时/中止路径先 abort 再 delete）。 */
  aborted: string[]
  /** config.providers 被调用次数（断言能力查询缓存时使用）。 */
  providers: number
}

/**
 * 构造 stub 的 opencode client：
 * - config.providers：默认返回三模型能力表（text-model 无视觉，其余有）
 * - session.create：返回递增子会话 id 并记录
 * - session.prompt：默认返回 "a red square" 描述，行为可注入
 * - session.delete：记录被删 id
 */
export function makeStubClient(input?: { providersResult?: StubProvidersResult }) {
  const calls: SessionCalls = { create: [], prompt: [], deleted: [], aborted: [], providers: 0 }
  let subSessionSeq = 0
  let providersResult: StubProvidersResult | (() => Promise<StubProvidersResult>) =
    input?.providersResult ?? {
      data: {
        providers: [
          {
            id: "test",
            // 默认单 provider 归属 config 源（自动发现时最优先）
            source: "config",
            models: {
              "text-model": { capabilities: { input: { image: false } } },
              "vision-model": { capabilities: { input: { image: true } } },
              "other-vision": { capabilities: { input: { image: true } } },
            },
          },
        ],
      },
    }
  let promptBehavior: (model?: { providerID: string; modelID: string }) => Promise<unknown> = async () => ({
    data: { parts: [{ type: "text", text: "a red square" }] },
  })
  return {
    calls,
    /** 注入 providers 返回值（固定对象或函数）。 */
    setProvidersResult: (next: StubProvidersResult | (() => Promise<StubProvidersResult>)) => {
      providersResult = next
    },
    /** 注入 session.prompt 行为（如永不 resolve、报错等）；可选收 model 以区分候选。 */
    setPromptBehavior: (behavior: (model?: { providerID: string; modelID: string }) => Promise<unknown>) => {
      promptBehavior = behavior
    },
    config: {
      providers: async () => {
        calls.providers += 1
        return typeof providersResult === "function" ? providersResult() : providersResult
      },
    },
    session: {
      create: async (args: { body: { parentID?: string; title?: string } }) => {
        calls.create.push({ parentID: args.body.parentID, title: args.body.title })
        subSessionSeq += 1
        return { data: { id: `ses_sub_${subSessionSeq}` } }
      },
      prompt: async (args: { path: { id: string }; body: Record<string, unknown> }) => {
        const body = args.body as { model?: { providerID: string; modelID: string }; parts: unknown[] }
        calls.prompt.push({ id: args.path.id, model: body.model, parts: body.parts })
        // 把当前尝试的 model 传给 behavior，便于按候选断言顺序/结果
        return promptBehavior(body.model)
      },
      delete: async (args: { path: { id: string } }) => {
        calls.deleted.push(args.path.id)
        return { data: true }
      },
      abort: async (args: { path: { id: string } }) => {
        calls.aborted.push(args.path.id)
        return { data: true }
      },
    },
  }
}

export type StubClient = ReturnType<typeof makeStubClient>

/** 构造 stub 的 PluginInput（directory 用真实临时目录）。 */
export function makePluginInput(directory: string, client: StubClient): PluginInput {
  return {
    client,
    project: { id: "prj_test", name: "test", worktree: directory, vcs: "git" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:4096"),
    $: undefined,
  } as unknown as PluginInput
}

/** 构造 stub 的 ToolContext（abort 用真实 AbortController 的 signal）。 */
export function makeToolContext(input: { sessionID: string; directory: string; signal: AbortSignal }): ToolContext {
  return {
    sessionID: input.sessionID,
    messageID: "msg_tool",
    agent: "build",
    directory: input.directory,
    worktree: input.directory,
    abort: input.signal,
    metadata: () => {},
    ask: async () => {},
  } as unknown as ToolContext
}

/** 插件加载结果：default 导出的 id + server 返回的 hooks。 */
export type LoadedPlugin = {
  id: string
  hooks: Awaited<ReturnType<import("../src/index")["default"]["server"]>>
}

/** 加载被测插件（default 导出 { id, server }），每个测试独立实例（闭包状态隔离）。 */
export async function loadPlugin(pluginInput: PluginInput, options: PluginOptions): Promise<LoadedPlugin> {
  const mod = (await import("../src/index")).default
  const hooks = await mod.server(pluginInput, options)
  return { id: mod.id, hooks }
}

/** chat.message 钩子的 stub 输出（parts 数组真实可变，push 可被断言）。 */
export function chatOutput(parts: Array<Record<string, unknown>>) {
  return { message: { id: "msg_1", model: MAIN_MODEL }, parts }
}

/** chat.message 钩子的 stub 输入。 */
export function chatInput(input: { sessionID: string; model?: { providerID: string; modelID: string } }) {
  return { sessionID: input.sessionID, agent: "build", model: input.model, messageID: "msg_1" }
}

// ---- 真实图片字节构造（供尺寸嗅探 / 裁剪流程测试） --------------------------

/** CRC32 查表（PNG 块校验用；避免依赖 zlib.crc32 的 node 版本差异）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** 构造一张纯色 RGB PNG（真实可被嗅探/解码）。 */
export function makePng(width: number, height: number, rgb: [number, number, number] = [200, 30, 30]): Buffer {
  const stride = 1 + width * 3
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

/** 构造最小 JPEG（SOI + APP1 Exif Orientation + SOF0 尺寸 + EOI），仅供嗅探测试。 */
export function makeExifJpeg(width: number, height: number, orientation: number, little = false): Buffer {
  const app1 = Buffer.alloc(2 + 6 + 2 + 2 + 4 + 2 + 12 + 4)
  app1.writeUInt16BE(app1.length, 0)
  app1.write("Exif", 2, "latin1")
  app1.writeUInt16BE(0, 6) // 填充
  app1.write(little ? "II" : "MM", 8, "latin1") // TIFF 字节序
  const u16 = (v: number, at: number) => (little ? app1.writeUInt16LE(v, at) : app1.writeUInt16BE(v, at))
  const u32 = (v: number, at: number) => (little ? app1.writeUInt32LE(v, at) : app1.writeUInt32BE(v, at))
  u16(0x2a, 10)
  u32(8, 12) // IFD0 偏移
  u16(1, 16) // 条目数
  u16(0x0112, 18) // Orientation tag
  u16(3, 20) // SHORT
  u32(1, 22)
  u16(orientation, 26)
  u32(0, 28)
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(11, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), app1, sof, Buffer.from([0xff, 0xd9])])
}

/** 构造最小 GIF 头（逻辑屏幕宽高，小端）。 */
export function makeGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13)
  buf.write("GIF89a", 0, "latin1")
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

/** 构造最小 WebP VP8L（无损）头：RIFF/WEBP/VP8L + 0x2f 签名 + 14-bit 宽高。 */
export function makeWebpVp8l(width: number, height: number): Buffer {
  const buf = Buffer.alloc(25)
  buf.write("RIFF", 0, "latin1")
  buf.writeUInt32LE(17, 4)
  buf.write("WEBP", 8, "latin1")
  buf.write("VP8L", 12, "latin1")
  buf.writeUInt32LE(5, 16)
  buf[20] = 0x2f
  // bits = (width-1) | ((height-1) << 14)
  buf.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21)
  return buf
}
