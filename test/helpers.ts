/**
 * 测试辅助：构造 stub 的插件运行环境（PluginInput / ToolContext），
 * 让单元测试无需运行中的 opencode 实例。
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PluginInput, PluginOptions, ToolContext } from "@opencode-ai/plugin"

/** 1x1 透明 PNG（68 字节），作为测试图片。 */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
export const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG.toString("base64")}`
export const TINY_PNG_SHA = createHash("sha256").update(TINY_PNG).digest("hex")

/** 临时项目目录（真实落盘可验证）。 */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "vision-analyze-test-"))
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

export type StubProvidersResult = {
  data?: { providers?: Array<{ id: string; models: Record<string, StubModel | undefined> }> }
  error?: unknown
}

/** session.* 调用记录（断言子会话生命周期时使用）。 */
export type SessionCalls = {
  create: Array<{ parentID?: string; title?: string }>
  prompt: Array<{ id: string; model?: { providerID: string; modelID: string }; parts: unknown[] }>
  deleted: string[]
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
  const calls: SessionCalls = { create: [], prompt: [], deleted: [], providers: 0 }
  let subSessionSeq = 0
  let providersResult: StubProvidersResult | (() => Promise<StubProvidersResult>) =
    input?.providersResult ?? {
      data: {
        providers: [
          {
            id: "test",
            models: {
              "text-model": { capabilities: { input: { image: false } } },
              "vision-model": { capabilities: { input: { image: true } } },
              "other-vision": { capabilities: { input: { image: true } } },
            },
          },
        ],
      },
    }
  let promptBehavior: () => Promise<unknown> = async () => ({
    data: { parts: [{ type: "text", text: "a red square" }] },
  })
  return {
    calls,
    /** 注入 providers 返回值（固定对象或函数）。 */
    setProvidersResult: (next: StubProvidersResult | (() => Promise<StubProvidersResult>)) => {
      providersResult = next
    },
    /** 注入 session.prompt 行为（如永不 resolve、报错等）。 */
    setPromptBehavior: (behavior: () => Promise<unknown>) => {
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
        return promptBehavior()
      },
      delete: async (args: { path: { id: string } }) => {
        calls.deleted.push(args.path.id)
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
