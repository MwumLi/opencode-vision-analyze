/**
 * opencode-vision-analyze
 *
 * 为「不具备视觉能力的主模型」提供图片解读路由：当用户在消息中附带图片时，
 * 插件把图片落盘到 .opencode/vision/<sha256>.<ext>，并向模型注入一条
 * synthetic 提示（TUI 界面隐藏、模型可见），引导它通过 vision_analyze 工具
 * 让指定的视觉模型描述图片。若主模型本身支持图片输入，则不做任何干预，
 * 原图直接发给主模型。
 *
 * 安装方式一（npm）：
 *   {
 *     "plugin": [["opencode-vision-analyze", { "model": "provider/vision-model" }]]
 *   }
 *
 * 安装方式二（curl 下载单文件，免 npm）：
 *   mkdir -p .opencode
 *   curl -fsSL <raw-url>/src/index.ts -o .opencode/vision-analyze.ts
 *   {
 *     "plugin": [["./.opencode/vision-analyze.ts", { "model": "provider/vision-model" }]]
 *   }
 *
 * 选项：
 *   - model（必填）：视觉模型的 "provider/model" 标识，例如 "anthropic/claude-sonnet-4-5"
 *   - timeout_ms：子会话请求的超时毫秒数（正数，默认 60000）
 *
 * 工作方式（vision_analyze 工具路径）：主模型调用 vision_analyze 时，插件
 * 创建一个 parentID 挂在当前会话下的临时子会话（不进会话列表、不生成
 * 标题、禁用全部工具），把原图以 data URL 发给视觉模型，取回描述文字后
 * 删除子会话并返回描述。同一张图 + 同一问题的描述按内容哈希缓存。
 * image_path 除了绝对路径也接受 http(s) URL：先下载落盘到同一 vision
 * 目录（内容哈希命名，天然与附件落盘去重），再走统一的磁盘加载路径。
 * 主模型本身支持图片输入时走快速路径：不做子会话描述，直接把原图作为
 * 工具附件回传给模型自行查看。
 *
 * 说明：本插件只用 node 内置模块（crypto/fs/path），无任何运行时外部依赖，
 * 类型依赖仅 @opencode-ai/plugin 与 @opencode-ai/sdk 的 type import。
 *
 * 已知限制：
 * - SSRF 面：downloadImage 的 fetch 跟随重定向、不拦截私网/云元数据地址。
 *   本地单用户 CLI 的信任级别下可接受；生产多租户环境使用前应加私网
 *   地址拦截。
 * - 中止不传导：用户中止不会取消进行中的下载/子会话请求，最长空跑至
 *   各自的 deadline（下载 30 秒、子会话 timeout_ms）；超时/中止后子会话
 *   虽被删除，但 provider 端已发出的孤儿回合仍可能计入用量。
 * - 仅 V1 会话流有效：chat.message 钩子挂在 V1 SessionPrompt 路径上；
 *   若交互默认切到 V2 Session 核心，本钩子不会触发（也不会报错）。
 */
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { FilePart, TextPart } from "@opencode-ai/sdk"
import type { Hooks, Plugin, PluginInput, PluginOptions, ToolContext, ToolResult } from "@opencode-ai/plugin"

/** 支持的图片扩展名 → MIME 类型（vision_analyze 加载磁盘图片时使用） */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/** MIME 类型 → 落盘使用的扩展名（与 EXT_MIME 互为反向映射） */
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
}

/**
 * 视觉子会话使用的系统提示词。
 * 要求：精确转录图中文字，描述 UI/布局/对象/颜色等，优先回答用户问题，
 * 不使用工具，纯文本回复。
 */
const VISION_SYSTEM_PROMPT = [
  "You are an image analysis assistant.",
  "Transcribe any text in the image exactly as it appears.",
  "Describe the UI layout, objects, positions, and colors when present.",
  "Answer the user's question first and foremost.",
  "Do not use tools. Reply with plain text only.",
].join("\n")

/** data URL 形如 data:<mime>;base64,<payload> */
const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/

/**
 * http(s) 下载图片的大小上限（20 MB）。提示注入可让模型指向超大图片，
 * 下载不限长是成本/健壮性放大器：先按 content-length 头提前拒绝，
 * 读取后再按实际字节数复核（防御不带 content-length 的响应）。
 */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/**
 * 插件服务端入口。
 *
 * @param input      opencode 插件运行环境（client / directory / project 等）
 * @param optionsArg 插件配置，来自 opencode.json 中 plugin 数组的第二项
 */
const plugin: Plugin = async (input: PluginInput, optionsArg?: PluginOptions): Promise<Hooks> => {
  // ---- 选项解析与校验 ----------------------------------------------------
  const model = optionsArg?.model
  if (typeof model !== "string" || !model.includes("/")) {
    throw new Error(
      `opencode-vision-analyze requires a "model" option in "provider/model" format, got: ${JSON.stringify(model)}`,
    )
  }
  const separator = model.indexOf("/")
  const visionProviderID = model.slice(0, separator)
  const visionModelID = model.slice(separator + 1)

  // 子会话请求的超时时间：timeout_ms 为正数时生效，默认 60 秒。
  const timeoutOption = optionsArg?.timeout_ms
  const timeoutMs =
    typeof timeoutOption === "number" && Number.isFinite(timeoutOption) && timeoutOption > 0 ? timeoutOption : 60000

  // ---- 闭包状态 ----------------------------------------------------------
  /** sessionID → 该会话最近一次 prompt 的模型（prompt 未显式指定 model 时回退使用） */
  const sessionModels = new Map<string, { providerID: string; modelID: string }>()
  /** "provider/model" → 是否具备图片输入能力（查询结果缓存，进程级） */
  const imageCapable = new Map<string, boolean>()
  /** 描述缓存："<sha>:<question>" → 描述文本（同一张图 + 同一个问题只描述一次） */
  const descriptions = new Map<string, string>()
  /** 本插件创建的子会话 ID 集合（正常路径用后即删，dispose 兜底清理残留） */
  const subSessions = new Set<string>()

  /** 任意错误值 → 可读文本：Error 取 message，字符串原样，其余 JSON 序列化兜底。 */
  const errText = (error: unknown): string => {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    return JSON.stringify(error) ?? String(error)
  }

  /**
   * 给子会话请求加超时与 abort 保护：任一触发即让 Promise 以错误结束，
   * 不再等待底层请求；finally 中清理 timer 与监听器，避免泄漏。
   */
  const withDeadline = <T>(promise: Promise<T>, ctx: ToolContext): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const guarded = new Promise<never>((_, reject) => {
      // ctx.abort 已中止时 abort 事件不会再触发，必须立即拒绝，
      // 否则 race 只能干等 timer 超时。
      if (ctx.abort.aborted) {
        reject(new DOMException("Aborted", "AbortError"))
        return
      }
      timer = setTimeout(() => reject(new Error(`vision model call timed out after ${timeoutMs}ms`)), timeoutMs)
      onAbort = () => reject(new DOMException("Aborted", "AbortError"))
      ctx.abort.addEventListener("abort", onAbort, { once: true })
    })
    return Promise.race([promise, guarded]).finally(() => {
      if (timer) clearTimeout(timer)
      if (onAbort) ctx.abort.removeEventListener("abort", onAbort)
    })
  }

  /**
   * 创建临时子会话（parentID 挂在当前会话下，不进会话列表、不生成标题），
   * 让视觉模型描述一张图片并返回描述文本。
   * 任何失败（会话创建 / 请求 / 超时 / abort / 无文本）都返回 { ok: false, error }。
   * 无论成败，finally 中都会删除子会话——用后即删，不留孤儿。
   */
  const describeImage = async (
    image: { bytes: Buffer; mime: string },
    question: string,
    ctx: ToolContext,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
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
            model: { providerID: visionProviderID, modelID: visionModelID },
            agent: "build",
            // 子会话禁用全部工具：视觉模型只做纯文本描述，避免它反过来调用
            // vision_analyze 形成递归，也避免任何副作用。
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
    } finally {
      if (subID) {
        subSessions.delete(subID)
        await input.client.session.delete({ path: { id: subID } }).catch(() => {})
      }
    }
  }

  /**
   * 下载 http(s) URL 指向的图片并落盘到 <visionDir>/<sha256><ext>：
   * 与 chat.message 落盘路径一致，内容哈希命名天然去重。
   * 扩展名不受支持、HTTP 非 2xx、网络失败（含 30 秒下载超时）、超过
   * 20 MB 下载上限（content-length 预检 + 读后复核）都返回 { error }，
   * 由调用方转成可读的错误文字。
   */
  const downloadImage = async (url: string): Promise<{ filepath: string } | { error: string }> => {
    try {
      // URL 解析与扩展名提取放在 try 内：畸形 URL 在 new URL 处抛错时，
      // 错误以 "Image download failed" 前缀返回，而不是漏到外层的
      // "Image analysis failed"。
      const ext = path.extname(new URL(url).pathname).toLowerCase()
      const mime = EXT_MIME[ext]
      if (!mime) return { error: `unsupported image URL extension: ${ext || "(none)"}` }
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return { error: `HTTP ${response.status}` }
      // 头字段缺失时 Number(null) 为 NaN，比较结果为 false，自然放行到读后复核。
      if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) {
        return { error: "image exceeds 20 MB download limit" }
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      // 复核实际字节数：chunked 等无 content-length 的响应只有读后才能判大小。
      if (bytes.length > MAX_DOWNLOAD_BYTES) {
        return { error: "image exceeds 20 MB download limit" }
      }
      const sha = createHash("sha256").update(bytes).digest("hex")
      const dir = path.join(input.directory, ".opencode", "vision")
      await fs.mkdir(dir, { recursive: true })
      const filepath = path.join(dir, `${sha}${ext}`)
      await fs.writeFile(filepath, bytes)
      return { filepath }
    } catch (error) {
      return { error: errText(error) }
    }
  }

  /**
   * 从磁盘加载图片：按扩展名识别 MIME，读取失败或文件为空返回 undefined。
   */
  const loadImage = async (filepath: string): Promise<{ bytes: Buffer; mime: string } | undefined> => {
    const mime = EXT_MIME[path.extname(filepath).toLowerCase()]
    if (!mime) return undefined
    try {
      const bytes = await fs.readFile(filepath)
      if (bytes.length === 0) return undefined
      return { bytes, mime }
    } catch {
      return undefined
    }
  }

  /**
   * vision_analyze 工具：主模型传入图片路径与问题，返回视觉模型给出的描述。
   * 工具永不抛错——所有失败都以错误文字返回，让 agent 循环可以读到原因并
   * 自行决定下一步（重试、换问题或告知用户）。
   */
  const visionAnalyze = async (
    args: { image_path: string; question: string },
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const title = "vision_analyze"
    try {
      const question = args.question?.trim() || "Describe this image in full detail."
      // http(s) URL：先下载到本地 vision 目录，再统一走磁盘加载路径。
      const download = /^https?:\/\//i.test(args.image_path) ? await downloadImage(args.image_path) : undefined
      if (download && "error" in download) {
        return { title, output: `Image download failed: ${download.error}` }
      }
      const imagePath = download ? download.filepath : args.image_path
      const image = await loadImage(imagePath)
      if (!image) {
        return { title, output: `Image not found or unsupported: ${args.image_path}` }
      }

      // 快速路径：主模型本身具备视觉能力时，不再走子会话描述，直接把原图
      // 作为附件回传给模型自行查看（省一次往返，模型看到的是原图而非转述）。
      const current = sessionModels.get(ctx.sessionID)
      if (current && (await imageSupport(current.providerID, current.modelID))) {
        return {
          title,
          output: `[Image attached for direct inspection: ${path.basename(imagePath)}]`,
          attachments: [
            {
              type: "file",
              mime: image.mime,
              url: `data:${image.mime};base64,${image.bytes.toString("base64")}`,
            },
          ],
        }
      }

      // 描述缓存：内容哈希 + 问题作为 key，命中直接复用（title 标注 cached）。
      const key = `${createHash("sha256").update(image.bytes).digest("hex")}:${question}`
      const format = (text: string) =>
        `[Image: ${path.basename(imagePath)} — described by ${visionProviderID}/${visionModelID}]\n${text}`
      const cached = descriptions.get(key)
      if (cached !== undefined) return { title: `${title} (cached)`, output: format(cached) }

      const result = await describeImage(image, question, ctx)
      if (!result.ok) return { title, output: `Image analysis failed: ${result.error}` }
      descriptions.set(key, result.text)
      return { title, output: format(result.text) }
    } catch (error) {
      return { title, output: `Image analysis failed: ${errText(error)}` }
    }
  }

  /**
   * 查询某个模型是否支持图片输入。
   * 通过 server 的 /config/providers 接口读取模型 capabilities.input.image，
   * 结果按 "provider/model" 缓存；任何失败都静默返回 false（保守处理：
   * 宁可多注入提示，也不让钩子抛错阻断消息持久化）。
   */
  const imageSupport = async (providerID: string, modelID: string): Promise<boolean> => {
    const key = `${providerID}/${modelID}`
    const cached = imageCapable.get(key)
    if (cached !== undefined) return cached
    try {
      const result = await input.client.config.providers()
      // HTTP 非 2xx 时 openapi-fetch 不抛错而是返回 { error }（data 为空）。
      // 「查询失败」不能缓存成 false——那是一次瞬时故障而非「确认不支持」，
      // 缓存会永久关闭能力门控；本次保守返回 false，下次再重试。
      if (!result.data) return false
      const provider = result.data.providers?.find((item) => item.id === providerID)
      const capable = provider?.models?.[modelID]?.capabilities?.input?.image === true
      imageCapable.set(key, capable)
      return capable
    } catch {
      return false
    }
  }

  /**
   * 把一个图片 file part 落盘到 <directory>/.opencode/vision/<sha256>.<ext>。
   * 文件名用内容哈希，天然去重（同一张图多次发送只落一份）。
   * 返回落盘信息；MIME 不受支持或 URL 不是 base64 data URL 时返回 undefined。
   */
  const persistImage = async (part: FilePart): Promise<{ filepath: string } | undefined> => {
    const ext = MIME_EXT[part.mime]
    if (!ext) return undefined
    const match = DATA_URL_PATTERN.exec(part.url)
    if (!match) return undefined
    try {
      const bytes = Buffer.from(match[2], "base64")
      const sha = createHash("sha256").update(bytes).digest("hex")
      const dir = path.join(input.directory, ".opencode", "vision")
      await fs.mkdir(dir, { recursive: true })
      const filepath = path.join(dir, `${sha}${ext}`)
      await fs.writeFile(filepath, bytes)
      return { filepath }
    } catch {
      // fail-open 原则：图片落盘失败（EACCES/ENOSPC 等）只是少了 vision_analyze
      // 提示，不应让用户消息落库失败。返回 undefined，外层逐图跳过。
      return undefined
    }
  }

  /**
   * chat.message 钩子：用户消息持久化前触发（parts 数组与持久化同引用，
   * push 进去的 part 会一并入库）。
   *
   * 职责：
   * 1. 递归防护——视觉模型自身的消息（例如子会话）不做任何处理；
   * 2. 记录会话当前模型；
   * 3. 收集图片 part，没有图片则直接返回；
   * 4. 能力门控——主模型本身能看图则不注入提示；
   * 5. 图片落盘，并注入一条 synthetic text part 引导模型使用 vision_analyze。
   */
  const onChatMessage: NonNullable<Hooks["chat.message"]> = async (hookInput, output) => {
    // 记录会话当前模型，供后续 vision_analyze 快速路径与未显式指定 model 的
    // prompt 回退判断。必须先于递归防护：会话模型恰好就是视觉模型时（用户
    // 直接用视觉模型开会话），sessionModels 也要记录，否则快速路径门控永远
    // 看不到该模型，会退化为子会话描述。
    if (hookInput.model) sessionModels.set(hookInput.sessionID, hookInput.model)

    // 递归防护：视觉模型自身的 prompt（描述子会话）直接放行，
    // 避免插件处理自己发起的消息造成循环。
    if (hookInput.model?.providerID === visionProviderID && hookInput.model?.modelID === visionModelID) return

    // 只处理 base64 图片附件；没有图片就没有副作用。
    const images = output.parts.filter(
      (part): part is FilePart => part.type === "file" && part.mime.startsWith("image/"),
    )
    if (images.length === 0) return

    // 能力门控：主模型有视觉能力时原图直发，不需要任何提示。
    const current = hookInput.model ?? sessionModels.get(hookInput.sessionID)
    if (current && (await imageSupport(current.providerID, current.modelID))) return

    // 每张图落盘并生成两行提示；任何一张落盘失败就跳过该图（不影响其余图片）。
    const lines: string[] = []
    for (const part of images) {
      const persisted = await persistImage(part)
      if (!persisted) continue
      lines.push(`[The user attached an image: ${part.filename ?? "image"}]`)
      lines.push(`[Examine it with the vision_analyze tool using image_path: ${persisted.filepath}]`)
    }
    if (lines.length === 0) return

    // 注入 synthetic text part：TUI 隐藏（不干扰用户输入展示），但会发给模型。
    // id 需满足 PartID 约定（prt 前缀）。
    const hint: TextPart = {
      id: `prt_${randomUUID()}`,
      sessionID: hookInput.sessionID,
      messageID: hookInput.messageID ?? output.message.id,
      type: "text",
      synthetic: true,
      text: lines.join("\n"),
    }
    output.parts.push(hint)
  }

  return {
    "chat.message": onChatMessage,
    // 工具注册。参数用 JSON-Schema 形式描述（image_path / question）。
    // 类型签名上 args 是 zod RawShape，但注册表对非 zod 的参数值走
    // JSON-Schema 兼容路径运行时处理；这里做一次受控的边界转换，
    // 既不引入 zod 运行时依赖（本插件只用 node 内置模块），也不使用 any。
    tool: {
      vision_analyze: {
        description:
          "Analyze an image with the dedicated vision model. image_path is an absolute file path (as given in the user's attachment hint) or an http(s) image URL. question describes what to look for; be specific.",
        args: {
          image_path: { type: "string", description: "Absolute path to the image file, or an http(s) image URL." },
          question: { type: "string", description: "What to look for or answer about the image." },
        },
        execute: visionAnalyze,
      },
    } as unknown as NonNullable<Hooks["tool"]>,
    // dispose：清理可能残留的子会话（正常路径用后即删，这里兜底异常路径），
    // 删除失败静默忽略——插件卸载不应因清理失败而报错。
    dispose: async () => {
      for (const id of subSessions) {
        await input.client.session.delete({ path: { id } }).catch(() => {})
      }
      subSessions.clear()
    },
  }
}

export default { id: "opencode-vision-analyze", server: plugin }
