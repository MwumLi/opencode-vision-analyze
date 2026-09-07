/**
 * opencode-vision-analyze
 *
 * 为「不具备视觉能力的主模型」提供图片解读路由：当用户在消息中附带图片时，
 * 插件把图片落盘到 vision 目录（git 项目内 → <项目>/.opencode/vision；
 * 非 git 目录 → 用户级缓存目录），并向模型注入一条 synthetic 提示
 * （TUI 界面隐藏、模型可见），引导它通过 vision_analyze 工具让指定的视觉
 * 模型描述图片。若主模型本身支持图片输入，则不做任何干预，原图直接发给主模型。
 *
 * 安装方式一（npm）：
 *   {
 *     "plugin": [["opencode-vision-analyze", { "models": ["provider/vision-model"] }]]
 *   }
 *
 * 安装方式二（curl 下载单文件，免 npm）：
 *   mkdir -p .opencode
 *   curl -fsSL <raw-url>/src/index.ts -o .opencode/vision-analyze.ts
 *   {
 *     "plugin": [["./.opencode/vision-analyze.ts", { "models": ["provider/vision-model"] }]]
 *   }
 *
 * 选项：
 *   - models（可选，缺省/空数组 = 自动模式）：有序视觉候选数组，如
 *     ["provider-a/m1", "provider-b/m2"]；单模型写 ["provider/model"] 即可
 *   - unlisted_fallback（可选，默认 false）：显式候选耗尽后自动续接未列出的 image-capable 模型
 *   - free_first（可选，默认 false）：自动发现档序反转（custom/匿名免费源优先，默认 config 优先）
 *   - timeout_ms：单候选子会话请求的超时毫秒数（正数，默认 60000）
 *
 * 候选链语义：显式 models 恒在链首；缺省/空数组 → 自动发现全部 image-capable
 * 模型并按 Provider.source 档序排列。链上候选逐个尝试，成功即止，全败聚合报错。
 * 描述子会话的模型属于候选链，chat.message 递归防护以整链成员为集。
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
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import { homedir } from "node:os"
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
 * 判断目录是否位于 git 项目内：从 dir 向上（含自身）逐级找 `.git`
 * （目录，或 worktree/submodule 的 `.git` 指针文件），到文件系统根为止。
 * 纯同步、纯内置模块；作为命名导出便于单元测试注入真实临时目录验证。
 */
export function isInsideGitRepo(dir: string): boolean {
  let cur = path.resolve(dir)
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return true
    const parent = path.dirname(cur)
    if (parent === cur) return false // 已到文件系统根
    cur = parent
  }
}

/** 用户级（非 git）图片缓存的平台根：cache 目录 + opencode-vision-analyze/vision。 */
export function userVisionCacheRoot(
  env: Record<string, string | undefined>,
  platform: string,
  home: string,
): string {
  const base =
    platform === "darwin"
      ? (env.XDG_CACHE_HOME ?? path.join(home, "Library", "Caches"))
      : platform === "win32"
        ? (env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"))
        : (env.XDG_CACHE_HOME ?? path.join(home, ".cache"))
  return path.join(base, "opencode-vision-analyze", "vision")
}

/**
 * 图片存储根：与 opencode 的项目/全局语义对齐——
 * git 项目内 → <项目>/.opencode/vision（现状）；非 git 目录 → 用户级缓存目录。
 * 解析一次即可（纯函数，入参可注入以便三平台与 env 覆盖的单测）。
 */
export function resolveVisionDir(
  inputDir: string,
  env: Record<string, string | undefined>,
  platform: string,
  home: string,
): string {
  if (isInsideGitRepo(inputDir)) return path.join(inputDir, ".opencode", "vision")
  return userVisionCacheRoot(env, platform, home)
}

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
  // 归一化规则：models 是唯一显式入口 —— 有序候选数组（保序去重，重复只留首个）。
  // 缺省或空数组 → explicit 为空（进入自动发现，见 resolveChain）。传了 models 但
  // 类型不对（非字符串数组）直接抛错，避免用户配错被静默当成自动模式。
  const modelsOption = optionsArg?.models
  if (optionsArg?.models !== undefined && !Array.isArray(modelsOption)) {
    throw new Error('opencode-vision-analyze option "models" must be an array of "provider/model" strings')
  }
  const hasModels = Array.isArray(modelsOption) && modelsOption.length > 0
  // 收集字符串候选并逐项校验 provider/model 格式（modelID 允许含 "/"，按首个 "/" 切分）。
  // 逐项 throw：元素非法报 label "models[i]"；保序去重（重复只留首个）。
  const raw = hasModels ? (modelsOption as string[]) : []
  const explicitModels: Array<{ providerID: string; modelID: string }> = []
  const seenKeys = new Set<string>()
  raw.forEach((item, index) => {
    const label = `models[${index}]`
    if (typeof item !== "string" || !item.includes("/")) {
      throw new Error(
        `opencode-vision-analyze option "${label}" must be in "provider/model" format, got: ${JSON.stringify(item)}`,
      )
    }
    const sep = item.indexOf("/")
    if (seenKeys.has(item)) return // 重复模型只保留首个
    seenKeys.add(item)
    explicitModels.push({ providerID: item.slice(0, sep), modelID: item.slice(sep + 1) })
  })
  // unlisted_fallback：显式链耗尽后是否自动续接未列出的 image-capable 模型（仅显式配置时
  // 生效）。free_first：自动发现档序是否反转（匿名/内置 custom 优先，默认 config 优先）。
  // 二者按严格布尔取真，非布尔值宽容忽略按 false 处理（与下方 timeout_ms 的宽容校验一致）。
  const fallbackUnlisted = optionsArg?.unlisted_fallback === true
  const freeFirst = optionsArg?.free_first === true

  // 子会话请求的超时时间：timeout_ms 为正数时生效，默认 60 秒。
  const timeoutOption = optionsArg?.timeout_ms
  const timeoutMs =
    typeof timeoutOption === "number" && Number.isFinite(timeoutOption) && timeoutOption > 0 ? timeoutOption : 60000

  // 图片存储根：解析一次（git 项目 → 项目 .opencode/vision；非 git → 用户级缓存）。
  // 下载与贴图落盘共用，见 resolveVisionDir 模块级注释。
  const visionDir = resolveVisionDir(input.directory, process.env, process.platform, homedir())

  // ---- 闭包状态 ----------------------------------------------------------
  /** sessionID → 该会话最近一次 prompt 的模型（prompt 未显式指定 model 时回退使用） */
  const sessionModels = new Map<string, { providerID: string; modelID: string }>()
  /** "provider/model" → 是否具备图片输入能力（查询结果缓存，进程级） */
  const imageCapable = new Map<string, boolean>()
  /**
   * 描述缓存："<sha>:<question>" → 描述结果（同一张图 + 同一个问题只描述一次）。
   * 值带 modelId：记录实际产出该描述的候选模型，缓存命中时标签沿用入库模型，
   * 而不是用当前候选链链首近似（链配置变化或 fallback 命中次选时标签才真实）。
   */
  const descriptions = new Map<string, { modelId: string; text: string }>()
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

  /** 判断错误是否为中止信号（AbortError），供 attemptModel 标记 / 链循环中止整链。 */
  const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError"

  /**
   * 单个候选的尝试：创建子会话（parentID 挂当前会话）→ 用该候选模型描述 →
   * 删除子会话。任何失败（创建 / 请求 / 超时 / 中止 / 底层抛错 / 无文本）都
   * 收敛为 { ok: false } 返回而不向上抛——推进与否交给 describeWithChain 的
   * 链循环决策；中止额外打 aborted 标记，链循环据此立即停整链。无论成败，
   * finally 中都删除子会话——用后即删，不留孤儿。
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
    } catch (error) {
      // 异常（超时 / 中止 / 底层抛错）同样收敛为失败结果；aborted 标记交由链循环判断
      return { ok: false, error: errText(error), aborted: isAbortError(error) }
    } finally {
      if (subID) {
        subSessions.delete(subID)
        await input.client.session.delete({ path: { id: subID } }).catch(() => {})
      }
    }
  }

  /**
   * 候选链描述：沿 resolveChain() 产出的候选链逐个尝试，首个成功即返回（附带
   * 成功候选的引用键作标签来源）；单个候选失败记录 `${key}: ${error}` 并推进
   * 下一个；收到 abort（pre-abort 短路或尝试结果的 aborted 标记）立即中止整链；
   * 全部失败聚合各候选原因；空链返回友好错误。本函数永不抛错。
   */
  const describeWithChain = async (
    image: { bytes: Buffer; mime: string },
    question: string,
    ctx: ToolContext,
  ): Promise<{ ok: true; text: string; modelId: string } | { ok: false; error: string }> => {
    // pre-abort 短路：不解析候选链、不建子会话，直接以 Aborted 收尾
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
          "no image-capable model configured (set the plugin models option or configure an image-capable provider model)",
      }
    }
    return { ok: false, error: `all ${failures.length} candidate model(s) failed: ${failures.join("; ")}` }
  }

  /** 描述标签：标注图片文件名与产出描述的模型引用键（basename 运行时按图传入）。 */
  const format = (basename: string, modelId: string, text: string): string =>
    `[Image: ${basename} — described by ${modelId}]\n${text}`

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
      // 共享目录（用户级/多实例）下并发写同一 sha：先写临时文件再 rename，内容寻址下原子幂等。
      await fs.mkdir(visionDir, { recursive: true, mode: 0o700 })
      const filepath = path.join(visionDir, `${sha}${ext}`)
      const tmpPath = path.join(visionDir, `${sha}${ext}.tmp-${randomUUID()}`)
      await fs.writeFile(tmpPath, bytes)
      await fs.rename(tmpPath, filepath)
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
      const cached = descriptions.get(key)
      if (cached !== undefined) {
        // 命中时标签沿用入库时的模型（cached.modelId）：即便此刻候选链链首
        // 已与入库模型不同，也保持标签真实、不重写。
        return { title: `${title} (cached)`, output: format(path.basename(imagePath), cached.modelId, cached.text) }
      }

      const result = await describeWithChain(image, question, ctx)
      if (!result.ok) return { title, output: `Image analysis failed: ${result.error}` }
      // 入库带上实际产出描述的候选 modelId，供后续缓存命中还原真实标签
      descriptions.set(key, { modelId: result.modelId, text: result.text })
      // 成功标签直接用实际产出描述的候选引用键（而非链首近似）
      return { title, output: format(path.basename(imagePath), result.modelId, result.text) }
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

  /** Provider.source → 自动发现档位：config 最优先，env/api 次之，custom 与未知值最末 */
  const tierOfSource = (source: string): number =>
    source === "config" ? 0 : source === "env" || source === "api" ? 1 : 2

  /** "provider/model" 引用键（与 imageCapable 缓存的键格式一致） */
  const modelRefKey = (c: { providerID: string; modelID: string }): string => `${c.providerID}/${c.modelID}`

  // 候选链 memoize：chat.message 钩子与 vision_analyze 工具共享一次 providers 查询
  let chainPromise: Promise<Array<{ providerID: string; modelID: string }>> | undefined
  /**
   * 归一化产出最终候选链（统一数组，运行时只做逐个尝试）：
   * - 显式非空：显式链恒在链首（不受 free_first/档序影响）；
   *   unlisted_fallback=true 时再追加未列出的 image-capable 模型
   * - 显式为空：整链 = 自动发现（全部 image-capable 模型，按 source 档序）
   */
  const resolveChain = (): Promise<Array<{ providerID: string; modelID: string }>> => {
    chainPromise ??= (async () => {
      // 自动模式：整链由自动发现决定
      if (explicitModels.length === 0) return listImageCapableModels()
      // 显式模式：默认只用显式链；unlisted_fallback=true 时追加 inventory 中未列出的模型
      if (!fallbackUnlisted) return explicitModels
      const inventory = await listImageCapableModels()
      const explicitSet = new Set(explicitModels.map(modelRefKey))
      return [...explicitModels, ...inventory.filter((c) => !explicitSet.has(modelRefKey(c)))]
    })()
    return chainPromise
  }

  /**
   * 枚举 config.providers() 中全部 image-capable 模型，并按 Provider.source 档位
   * 稳定排序（档内保持 providers 返回顺序）：默认 config > env/api > custom；
   * free_first=true 时档序反转（custom 优先）。顺带预填 imageCapable 缓存
   * （与 imageSupport 同源，避免后续重复请求）。providers 查询瞬时失败返回空数组
   * 并记日志：显式链仍可用（fallback 追加部分静默跳过），自动模式退化为空链——
   * 因 resolveChain 的 memoize，本次空链会持续整个进程（见 docs/superpowers/specs/2026-09-05-opencode-vision-analyze-design.md 已知限制）。
   */
  const listImageCapableModels = async (): Promise<Array<{ providerID: string; modelID: string }>> => {
    try {
      const result = await input.client.config.providers()
      if (!result.data) return []
      const found: Array<{ providerID: string; modelID: string; tier: number }> = []
      for (const provider of result.data.providers ?? []) {
        const tier = tierOfSource(provider.source)
        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          if (model?.capabilities?.input?.image !== true) continue
          imageCapable.set(`${provider.id}/${modelID}`, true)
          found.push({ providerID: provider.id, modelID, tier })
        }
      }
      // 稳定排序：默认按档位升序（config 优先）；free_first 反转成降序（custom 优先）
      found.sort((a, b) => (freeFirst ? b.tier - a.tier : a.tier - b.tier))
      return found.map(({ providerID, modelID }) => ({ providerID, modelID }))
    } catch (error) {
      // 自动发现的关键 providers 查询失败要可观测：不静默吞掉，记一行日志便于定位。
      // 显式链不受影响；自动模式按空链处理（本次进程内不再重试，见已知限制）。
      console.error("[opencode-vision-analyze] config.providers() failed; auto vision discovery disabled", error)
      return []
    }
  }

  /** 判断某 model 是否为当前候选链成员（chat.message 递归防护用） */
  const isCandidateModel = async (model: { providerID: string; modelID: string }): Promise<boolean> => {
    const chain = await resolveChain()
    return chain.some((c) => c.providerID === model.providerID && c.modelID === model.modelID)
  }

  /**
   * 把一个图片 file part 落盘到 <visionDir>/<sha256>.<ext>（visionDir 见 resolveVisionDir）。
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
      // 与下载路径一致：先写临时文件再 rename，保证并发写同一 sha 时最终文件完整。
      await fs.mkdir(visionDir, { recursive: true, mode: 0o700 })
      const filepath = path.join(visionDir, `${sha}${ext}`)
      const tmpPath = path.join(visionDir, `${sha}${ext}.tmp-${randomUUID()}`)
      await fs.writeFile(tmpPath, bytes)
      await fs.rename(tmpPath, filepath)
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
   * 1. 记录会话当前模型（先于递归防护：会话模型恰为视觉模型时也需记录）；
   * 2. 收集图片 part，没有图片则直接返回；
   * 3. 递归防护——消息模型 ∈ 候选链全体成员（我们的描述子会话）则放行；
   * 4. 能力门控——主模型本身能看图则不注入提示；
   * 5. 空链降级——没有任何可用视觉模型时不注入 hint；
   * 6. 图片落盘，并注入一条 synthetic text part 引导模型使用 vision_analyze。
   */
  const onChatMessage: NonNullable<Hooks["chat.message"]> = async (hookInput, output) => {
    // 记录会话当前模型，供后续 vision_analyze 快速路径与未显式指定 model 的
    // prompt 回退判断。必须先于递归防护：会话模型恰好就是视觉模型时（用户
    // 直接用视觉模型开会话），sessionModels 也要记录，否则快速路径门控永远
    // 看不到该模型，会退化为子会话描述。
    if (hookInput.model) sessionModels.set(hookInput.sessionID, hookInput.model)

    // 只处理 base64 图片附件；没有图片就没有副作用。
    const images = output.parts.filter(
      (part): part is FilePart => part.type === "file" && part.mime.startsWith("image/"),
    )
    if (images.length === 0) return

    // 递归防护：防护集 = 整条候选链（而非单模型/链首）。描述子会话用的模型是
    // 链上任意候选，只要消息模型命中任一成员就放行，避免插件处理自己发起的
    // 消息形成循环。resolveChain 懒加载 + memoize，只在首次触发一次 providers 查询。
    if (hookInput.model && (await isCandidateModel(hookInput.model))) return

    // 能力门控：主模型有视觉能力时原图直发，不需要任何提示。
    const current = hookInput.model ?? sessionModels.get(hookInput.sessionID)
    if (current && (await imageSupport(current.providerID, current.modelID))) return

    // 空链降级：没有任何可用视觉模型时不注入 hint、不落盘——落盘只会制造没有
    // 视觉模型可消费的垃圾文件；交给核心 unsupportedParts 对图片 part 的默认处理。
    const chain = await resolveChain()
    if (chain.length === 0) return

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
