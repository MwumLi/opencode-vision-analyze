/**
 * opencode-vision-analyze
 *
 * 为「不具备视觉能力的主模型」提供图片解读路由：当用户在消息中附带图片时，
 * 插件把图片落盘到**用户级共享目录**（<cache>/opencode-vision-analyze/vision，
 * 恒用户级、与 git/非 git 无关），并向模型注入一条 synthetic 提示
 * （TUI 界面隐藏、模型可见），引导它通过 vision_analyze 工具让指定的视觉
 * 模型描述图片。若主模型本身支持图片输入，则不做任何干预，原图直接发给主模型。
 *
 * 工作方式（vision_analyze 工具路径）：主模型调用 vision_analyze 时，插件
 * 创建一个 parentID 挂在当前会话下的临时子会话（不进会话列表、不生成
 * 标题、禁用全部工具），把原图以 data URL 发给视觉模型，取回描述文字后
 * 删除子会话并返回描述。描述按「<图片sha256>:<问题>」键缓存到**用户级共享目录**
 * （<cache>/opencode-vision-analyze/descriptions，每条目一文件、mtime 作 LRU
 * 时钟、2000 条 / 50MB 双上限、单条超限不入缓存）——跨项目/跨进程/插件重启后
 * 同图同问题只描述一次。
 * 泛解析（描述整图）请求的 question 会归一化到固定文案 GENERIC_QUESTION
 * （主模型省略 question 即走该默认值），key 收敛为 <图片sha>:GENERIC_QUESTION，
 * 避免主模型每次自编措辞把缓存拆碎；有具体追问时保留原问句走各自精确 key。
 * 泛解析条目是全图共享的，写入前按最短文本长度把关，防一条垃圾描述毒化整图。
 * image_path 除了绝对路径也接受 http(s) URL：先下载落盘到同一用户级 vision
 * 目录（内容哈希命名，天然与附件落盘去重；LRU + 容量上限，2000 条 / 500MB），
 * 再走统一的磁盘加载路径。**本地已存在的文件直接原位读取**（不复制、不 touch），
 * 只有贴图/下载才写缓存。
 * 主模型本身支持图片输入时走快速路径：不做子会话描述，直接把原图作为
 * 工具附件回传给模型自行查看。
 *
 * 说明：本插件只用 node 内置模块（crypto/fs/path），无任何运行时外部依赖，
 * 类型依赖仅 @opencode-ai/plugin 与 @opencode-ai/sdk 的 type import。
 *
 * 已知限制：
 * - 仅 V1 会话流有效：chat.message 钩子挂在 V1 SessionPrompt 路径上；
 *   若交互默认切到 V2 Session 核心，本钩子不会触发（也不会报错）。
 */
import { createHash, randomUUID } from "node:crypto"
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
 * 内部超时错误类型（name = "DeadlineError"）。
 * 与 AbortError 并列可判别：超时路径（providers 查询 / 子会话请求）据此判断
 * "底层请求可能仍在飞"，供调用方决定是否需要 abort 取消（见 attemptModel）。
 */
class DeadlineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeadlineError"
  }
}

/**
 * `config.providers()` 能力查询的超时预算（毫秒）。做成可改写对象（而非常量/选项）：
 * 避免选项膨胀；测试把 ms 调小即可缩短等待（TS 不允许对 import 的 let 绑定赋值）。
 */
export const providersTimeout = { ms: 5000 }

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
 * 用户级 cache 的平台根（不带应用子目录）：cache 目录 + opencode-vision-analyze。
 * 空字符串 env 视为未设置（XDG/LOCALAPPDATA 官规：空值=未设置）——避免把 "" 当
 * 有效根导致 path.join("",…) 产出相对路径、相对进程 cwd 落盘。
 * darwin 亦接受 $XDG_CACHE_HOME 覆盖（跨平台统一 dotfiles 的宽容超集）。
 */
export function userCacheRootBase(
  env: Record<string, string | undefined>,
  platform: string,
  home: string,
): string {
  const base =
    platform === "darwin"
      ? (env.XDG_CACHE_HOME || path.join(home, "Library", "Caches"))
      : platform === "win32"
        ? (env.LOCALAPPDATA || path.join(home, "AppData", "Local"))
        : (env.XDG_CACHE_HOME || path.join(home, ".cache"))
  return path.join(base, "opencode-vision-analyze")
}

/**
 * 图片缓存的平台根（恒用户级、与 git 无关）：cache 目录 + opencode-vision-analyze/vision。
 * 贴图与 http(s) 下载统一落盘于此（内容寻址命名）；本地已存在文件不复制、原位读用。
 */
export function userVisionCacheRoot(
  env: Record<string, string | undefined>,
  platform: string,
  home: string,
): string {
  return path.join(userCacheRootBase(env, platform, home), "vision")
}

/**
 * 描述缓存的持久化目录：恒走用户级共享 cache（<cache>/opencode-vision-analyze/descriptions），
 * **与 git / 非 git 分域无关**。描述缓存键是「图片内容 sha + 问题」，与项目解耦，放用户级
 * 目录才能在跨项目 / 跨进程 / 重启后共享同一份"同图同问题只描述一次"的结果。
 * 纯函数（入参注入 env/platform/homedir，便于三平台 + 空串 env 回退的单测）。
 */
export function resolveDescriptionDir(
  env: Record<string, string | undefined>,
  platform: string,
  home: string,
): string {
  return path.join(userCacheRootBase(env, platform, home), "descriptions")
}

/**
 * 描述缓存的容量上限（模块级可变对象，便于测试注入小值；与 providersTimeout 同风格）。
 * - maxEntries：最大条目数（2000）
 * - maxBytes：条目文件字节总和上限（50 MB）
 * 容量超限触发 LRU 淘汰（按文件 mtime 升序删最旧）。**单条即超 maxBytes 的条目不入缓存**
 * （A / 硬上限，写前 utf8 字节预检跳过），保证磁盘恒 ≤ maxBytes、不因巨值挤掉已付费条目。
 */
export const descriptionCacheLimits = {
  maxEntries: 2000,
  maxBytes: 50 * 1024 * 1024,
}

/**
 * 图片缓存的容量上限（模块级可变对象，便于测试注入小值；与 providersTimeout 同风格）。
 * - maxEntries：最大条目数（2000）
 * - maxBytes：条目文件字节总和上限（500 MB）
 * 容量超限触发 LRU 淘汰（按文件 mtime 升序删最旧）。与描述缓存不同，图片**允许单图超限**
 * （贴图/下载必须给模型稳定 image_path，不能拒绝落盘）：单图 > maxBytes 仍写入且当次受
 * protect 保护，容量可短暂超限，待下一次无关写入淘汰时收敛（best-effort）。
 */
export const visionCacheLimits = {
  maxEntries: 2000,
  maxBytes: 500 * 1024 * 1024,
}

/**
 * 泛解析（描述整张图）用的固定问题文案。
 *
 * 主模型对「解析这张图 / 描述图片」这类请求应省略 question，由工具用这里的文案兜底，
 * 从而让所有泛解析请求的缓存 key 收敛到同一条（key = <图片sha>:GENERIC_QUESTION），
 * 避免主模型每次自编措辞把缓存拆成多份、跨会话永远命中不了。
 *
 * 这份文案相当于公开契约：改动它会让旧的泛解析缓存条目失去命中（由 LRU 按 mtime 清理），
 * 属于刻意为之——将来想改泛描述措辞、或按用户/场景定制时，改文案即可自然分开新旧缓存。
 */
export const GENERIC_QUESTION = "Describe this image in full detail."

/**
 * 泛解析缓存条目的最短文本长度（字符）。
 *
 * canonical 描述要求整图加逐字转录，正常结果不可能太短；太短多半是视觉模型敷衍或拒答。
 * 泛解析条目是全图共享的，存进一条垃圾描述会让之后所有泛解析都命中它，所以写入时长度
 * 低于该值就跳过。具体追问不受限制（“答案是 42”是合法答案）。
 * 做成模块级可变对象，测试注入大值/小值验证两侧行为。
 */
export const genericWriteMinText = { chars: 100 }

/**
 * 归一化问题文本，供「是否为泛解析」判定使用：
 * 去掉首尾空白与引号/括号，把连续空白（含全角/换行）折成一个空格，去掉句末标点，统一小写。
 * 只做字符级归一化，不做语义匹配——误判泛解析会把针对性回答套到错误语义上，宁可 miss。
 */
export function normalizeQuestion(q: string): string {
  return q
    .trim()
    .replace(/^[\s"'“”「」『』()（）\[\]]+|[\s"'“”「」『』()（）\[\]]+$/g, "")
    .replace(/[\s]+/g, " ")
    .replace(/[.。!！?？]+$/g, "")
    .toLowerCase()
}

/** 是否泛解析请求：没给问题（空/纯空白），或归一化后与 GENERIC_QUESTION 一致。 */
export function isGenericQuestion(q: string): boolean {
  const s = (q ?? "").trim()
  return s === "" || normalizeQuestion(s) === normalizeQuestion(GENERIC_QUESTION)
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

  // ---- 闭包状态 ----------------------------------------------------------
  /** sessionID → 该会话最近一次 prompt 的模型（prompt 未显式指定 model 时回退使用） */
  const sessionModels = new Map<string, { providerID: string; modelID: string }>()
  /** "provider/model" → 是否具备图片输入能力（查询结果缓存，进程级） */
  const imageCapable = new Map<string, boolean>()
  /** 本插件创建的子会话 ID 集合（正常路径用后即删，dispose 兜底清理残留） */
  const subSessions = new Set<string>()

  /** 任意错误值 → 可读文本：Error 取 message，字符串原样，其余 JSON 序列化兜底。 */
  const errText = (error: unknown): string => {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    return JSON.stringify(error) ?? String(error)
  }

  /**
   * 无 ToolContext 的超时原语：到期以 DeadlineError(timeoutMessage) 拒绝。
   * 与 withDeadline 的差别是它不感知 abort——能力查询（providers）等无 ctx 的
   * 请求只关心"别永久挂起"，不需要监听用户中止；子会话请求由 withDeadline 组合
   * abort 信号后复用它，保证全插件只有一套计时机制。
   */
  const withTimeout = async <T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(timeoutMessage)), ms)
    })
    try {
      return await Promise.race([promise, guard])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 给子会话请求加超时与 abort 保护：任一触发即让 Promise 以错误结束，
   * 不再等待底层请求；超时复用 withTimeout（DeadlineError），abort 仍以
   * AbortError 拒绝；finally 中清理 timer 与监听器，避免泄漏。
   */
  const withDeadline = <T>(promise: Promise<T>, ctx: ToolContext): Promise<T> => {
    // ctx.abort 已中止时 abort 事件不会再触发，必须立即拒绝，
    // 否则 race 只能干等 timer 超时。
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
    ).finally(() => {
      if (onAbort) ctx.abort.removeEventListener("abort", onAbort)
    })
  }

  /** 判断错误是否为中止信号（AbortError），供 attemptModel 标记 / 链循环中止整链。 */
  const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError"

  /** 判断错误是否为本插件超时信号（DeadlineError）——与 AbortError 并列，表示"请求到期被本地掐断"。 */
  const isDeadlineError = (error: unknown): boolean => error instanceof Error && error.name === "DeadlineError"

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
    // "回合可能仍在飞"标记：请求被本地 deadline（超时）或用户 abort 掐断时置位，
    // finally 据此先 abort 子会话（取消 provider 端孤儿回合）再 delete。
    let endedByDeadline = false
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
      // 异常（超时 / 中止 / 底层抛错）同样收敛为失败结果；aborted 标记交由链循环判断。
      // 超时与中止都意味着底层请求可能仍在飞 → 需要先 abort 再 delete。
      endedByDeadline = isDeadlineError(error) || isAbortError(error)
      return { ok: false, error: errText(error), aborted: isAbortError(error) }
    } finally {
      if (subID) {
        subSessions.delete(subID)
        // 先 abort（best-effort，取消 provider 端孤儿回合）再 delete；
        // 成功/普通失败路径 turn 已自然结束，无需 abort。
        if (endedByDeadline) {
          await input.client.session.abort({ path: { id: subID } }).catch(() => {})
        }
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
   * 把图片字节内容原子落盘到**用户级缓存目录**（<cache>/opencode-vision-analyze/vision，
   * 与 git 无关）并返回最终 filepath。贴图与 http(s) 下载统一经此写入（本地已存在文件
   * 不复制、直接原位读用）。先写 `<sha><ext>.tmp-<uuid>` 再 rename：共享目录多进程并发
   * 写同一 sha 时内容寻址下原子幂等；失败先清理临时文件再抛错，避免孤儿 tmp 累积。
   * rename 成功后触发图片 LRU 容量淘汰（刚写入文件受 protect 保护）。
   */
  const persistImageBytes = async (bytes: Buffer, ext: string): Promise<string> => {
    const dir = userVisionCacheRoot(process.env, process.platform, homedir())
    const sha = createHash("sha256").update(bytes).digest("hex")
    const filepath = path.join(dir, `${sha}${ext}`)
    const tmpPath = path.join(dir, `${sha}${ext}.tmp-${randomUUID()}`)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await fs.writeFile(tmpPath, bytes)
      await fs.rename(tmpPath, filepath)
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {})
      throw error
    }
    await evictToCaps(dir, visionCacheLimits, {
      filter: (name) => /^[0-9a-f]{64}\.(png|jpe?g|gif|webp)$/i.test(name),
      protectName: path.basename(filepath),
    })
    return filepath
  }

  /**
   * 下载 http(s) URL 指向的图片并落盘（内容哈希命名天然去重，写盘细节见
   * persistImageBytes）。扩展名不受支持、HTTP 非 2xx、网络失败（含 30 秒下载
   * 超时）、超过 20 MB 下载上限（content-length 预检 + 读后复核）都返回 { error }，
   * 由调用方转成可读的错误文字。
   *
   * 中止传导：abort（用户中止）与 30 秒超时共同驱动一个 AbortController——
   * 中止即刻断请求，不空跑满超时；pre-abort 直接放弃、不发请求。手动组合信号
   * 而非 AbortSignal.any()：engines node>=18（any 需 18.17+/20.3+），且与
   * withDeadline 的 addEventListener 风格同构。错误以 AbortError/超时形式落入
   * catch，统一转可读文字。
   */
  const downloadImage = async (
    url: string,
    abort: AbortSignal,
  ): Promise<{ filepath: string } | { error: string }> => {
    try {
      // URL 解析与扩展名提取放在 try 内：畸形 URL 在 new URL 处抛错时，
      // 错误以 "Image download failed" 前缀返回，而不是漏到外层的
      // "Image analysis failed"。
      const ext = path.extname(new URL(url).pathname).toLowerCase()
      const mime = EXT_MIME[ext]
      if (!mime) return { error: `unsupported image URL extension: ${ext || "(none)"}` }
      // pre-abort：已中止则不必发请求，直接以 Aborted 收尾
      if (abort.aborted) return { error: "Aborted" }

      const controller = new AbortController()
      const onAbort = () => controller.abort()
      abort.addEventListener("abort", onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        // 整个下载（fetch 响应头 + arrayBuffer 读 body）都在同一 guard 内：
        // 30 秒预算与用户中止都覆盖到 body 读取阶段；收尾再清 timer/listener。
        const response = await fetch(url, { signal: controller.signal })
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
        return { filepath: await persistImageBytes(bytes, ext) }
      } finally {
        clearTimeout(timer)
        abort.removeEventListener("abort", onAbort)
      }
    } catch (error) {
      return { error: errText(error) }
    }
  }

  /**
   * 从磁盘加载图片：按扩展名识别 MIME，读取失败或文件为空返回 undefined。
   * LRU 时钟：**仅当图片位于本插件 vision 缓存根内**（贴图/下载落盘产物）才 touch mtime；
   * 流程 B 直读的外部本地文件绝不触碰（不得改写用户文件 mtime）。
   */
  const loadImage = async (filepath: string): Promise<{ bytes: Buffer; mime: string } | undefined> => {
    const mime = EXT_MIME[path.extname(filepath).toLowerCase()]
    if (!mime) return undefined
    try {
      const bytes = await fs.readFile(filepath)
      if (bytes.length === 0) return undefined
      const visionRoot = userVisionCacheRoot(process.env, process.platform, homedir())
      const rel = path.relative(visionRoot, filepath)
      if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        // 命中缓存内文件 → touch mtime 作 LRU 时钟（best-effort，失败不影响读）
        const now = new Date()
        await fs.utimes(filepath, now, now).catch(() => {})
      }
      return { bytes, mime }
    } catch {
      return undefined
    }
  }

  // ---- 描述缓存（用户级目录落盘，磁盘即事实；全链 fail-open） ---------------------
  /** 描述缓存 key → 磁盘文件路径（<dir>/<sha256(key)>.json）。 */
  const descCacheFile = (key: string): string =>
    path.join(resolveDescriptionDir(process.env, process.platform, homedir()), `${createHash("sha256").update(key).digest("hex")}.json`)

  /** 读取描述缓存：命中（JSON shape 合法）touch mtime 后返回，任何失败一律 miss。 */
  const descCacheGet = async (key: string): Promise<{ modelId: string; text: string } | undefined> => {
    try {
      const file = descCacheFile(key)
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { modelId?: unknown }).modelId !== "string" ||
        typeof (raw as { text?: unknown }).text !== "string"
      ) {
        return undefined
      }
      const value = raw as { modelId: string; text: string }
      // 命中即触摸 mtime → 作为 LRU 时钟（best-effort）
      const now = new Date()
      await fs.utimes(file, now, now).catch(() => {})
      return value
    } catch {
      return undefined
    }
  }

  /**
   * 写描述缓存（tmp+rename 原子）并触发容量淘汰；任何失败静默吞掉（best-effort）。
   * 超限策略（A / 硬上限）：序列化后先按 utf8 字节预检，单条 > maxBytes 则**不入缓存**
   * （不写盘、不触发淘汰、不删除该 key 已有的旧条目）——避免"超限巨值挤掉全部已付费条目、
   * 且自身活不过下一次无关写入"的写→删抖动，保证磁盘恒 ≤ maxBytes。
   */
  const descCacheSet = async (key: string, value: { modelId: string; text: string }): Promise<void> => {
    const payload = JSON.stringify(value)
    // 口径与 evict 的 fs.stat().size 一致：磁盘 utf8 字节，非字符串 length（中文/emoji 不等价）
    if (Buffer.byteLength(payload, "utf8") > descriptionCacheLimits.maxBytes) return
    const file = descCacheFile(key)
    const dir = path.dirname(file)
    const tmp = path.join(dir, `${path.basename(file)}.tmp-${randomUUID()}`)
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      await fs.writeFile(tmp, payload)
      await fs.rename(tmp, file)
    } catch {
      await fs.unlink(tmp).catch(() => {})
      return
    }
    await evictToCaps(dir, descriptionCacheLimits, {
      filter: (name) => name.endsWith(".json"),
      protectName: path.basename(file),
    })
  }

  /**
   * 通用 LRU + 容量淘汰（描述/图片缓存复用）：超出 limits.maxEntries / maxBytes 时按
   * mtime 升序删最旧，直到双条件满足。filter 限定参与淘汰的文件（描述 .json；图片 sha 文件，
   * 排除 tmp 残留）；protectName 保护刚写入的条目不被本次淘汰自删。
   */
  const evictToCaps = async (
    dir: string,
    limits: { maxEntries: number; maxBytes: number },
    opts: { filter: (name: string) => boolean; protectName?: string },
  ): Promise<void> => {
    try {
      const names = (await fs.readdir(dir)).filter(opts.filter)
      const stats = await Promise.all(
        names.map(async (name) => {
          try {
            const s = await fs.stat(path.join(dir, name))
            return { name, size: s.size, mtimeMs: s.mtimeMs }
          } catch {
            return undefined
          }
        }),
      )
      const entries = stats.filter((s): s is NonNullable<typeof s> => s !== undefined)
      const { maxEntries, maxBytes } = limits
      let total = entries.reduce((sum, e) => sum + e.size, 0)
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
      // 逐条删最旧直至双条件满足；刚写入的条目受保护（极端单条超限时保留最新，不自我删除）。
      // 用额外计数控制，不就地改遍历数组（entries 仅作删除候选快照）。
      let remaining = entries.length
      for (const entry of entries) {
        if (total <= maxBytes && remaining <= maxEntries) break
        if (entry.name === opts.protectName) continue
        await fs.unlink(path.join(dir, entry.name)).catch(() => {})
        total -= entry.size
        remaining -= 1
      }
    } catch {
      // 目录扫描/删除失败忽略：淘汰是 best-effort，下次写入再触发
    }
  }

  /**
   * vision_analyze 工具：主模型传入图片路径与问题，返回视觉模型给出的描述。
   * 工具永不抛错——所有失败都以错误文字返回，让 agent 循环可以读到原因并
   * 自行决定下一步（重试、换问题或告知用户）。
   */
  const visionAnalyze = async (
    args: { image_path: string; question?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const title = "vision_analyze"
    try {
      // 泛解析判定：没给问题（空/纯空白），或措辞与 GENERIC_QUESTION 归一化一致。
      // 泛解析请求统一改写为 GENERIC_QUESTION——缓存 key 固定成 <图片sha>:GENERIC_QUESTION，
      // 跨会话、跨措辞都能命中；主模型若问的是具体对象/文字/区域/颜色，则保留原问句，
      // 走各自的精确 key（与旧版本格式一致，存量条目不受影响）。
      const trimmed = args.question?.trim() ?? ""
      const generic = trimmed === "" || isGenericQuestion(trimmed)
      const question = generic ? GENERIC_QUESTION : trimmed
      // http(s) URL：先下载到用户级 vision 缓存目录，再统一走磁盘加载路径。
      // ctx.abort 传入下载：用户中止即刻断下载（含 pre-abort 不再发请求）。
      const download = /^https?:\/\//i.test(args.image_path)
        ? await downloadImage(args.image_path, ctx.abort)
        : undefined
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

      // 描述缓存：内容哈希 + 生效问题作为 key，命中直接复用（title 标注 cached）。
      // 落盘在用户级共享目录（resolveDescriptionDir）——跨项目/进程/重启命中；磁盘即事实。
      const key = `${createHash("sha256").update(image.bytes).digest("hex")}:${question}`
      const cached = await descCacheGet(key)
      if (cached !== undefined) {
        // 命中时标签沿用入库时的模型（cached.modelId）：即便此刻候选链链首
        // 已与入库模型不同，也保持标签真实、不重写。
        return { title: `${title} (cached)`, output: format(path.basename(imagePath), cached.modelId, cached.text) }
      }

      const result = await describeWithChain(image, question, ctx)
      if (!result.ok) return { title, output: `Image analysis failed: ${result.error}` }
      // 泛解析条目是全图共享的：文本太短多半是视觉模型敷衍/拒答，存进去会毒化这条
      // canonical 缓存，让以后所有泛解析都命中垃圾描述，所以低于门槛就跳过落盘。
      // 具体追问不受限（"答案是 42" 是合法短答案）。
      if (generic && result.text.length < genericWriteMinText.chars) {
        return { title, output: format(path.basename(imagePath), result.modelId, result.text) }
      }
      // 入库带上实际产出描述的候选 modelId，供后续缓存命中还原真实标签
      await descCacheSet(key, { modelId: result.modelId, text: result.text })
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
      const result = await withTimeout(
        input.client.config.providers(),
        providersTimeout.ms,
        `config.providers() timed out after ${providersTimeout.ms}ms`,
      )
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
      const result = await withTimeout(
        input.client.config.providers(),
        providersTimeout.ms,
        `config.providers() timed out after ${providersTimeout.ms}ms`,
      )
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
   * 把一个图片 file part 落盘（内容哈希命名去重，写盘细节见 persistImageBytes）。
   * 返回落盘信息；MIME 不受支持或 URL 不是 base64 data URL 时返回 undefined。
   */
  const persistImage = async (part: FilePart): Promise<{ filepath: string } | undefined> => {
    const ext = MIME_EXT[part.mime]
    if (!ext) return undefined
    const match = DATA_URL_PATTERN.exec(part.url)
    if (!match) return undefined
    try {
      const bytes = Buffer.from(match[2], "base64")
      return { filepath: await persistImageBytes(bytes, ext) }
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

    // 泛解析指引：主模型对"描述整图/解析图片"这类请求应省略 question（工具内部会用固定
    // canonical 文案兜底，缓存 key 才能跨会话收敛）；只有用户问具体对象/文字/区域/颜色时才
    // 填具体问句。措辞分化的泛问句会让缓存 key 拆碎、永远命中不了。
    lines.push(
      "[When the user asks for a general parse of the whole image, call vision_analyze WITHOUT a question (omit the question parameter). Only pass a question when the user asks about a specific object, text, region, or color.]",
    )

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
          "Analyze an image with the dedicated vision model. image_path is an absolute file path (as given in the user's attachment hint) or an http(s) image URL. question is optional: pass it only when you need a specific detail (an object, text, region or color); otherwise omit it to get a full description of the whole image.",
        args: {
          image_path: { type: "string", description: "Absolute path to the image file, or an http(s) image URL." },
          question: {
            type: "string",
            description:
              "Optional. Defaults to the full-image prompt: " +
              JSON.stringify(GENERIC_QUESTION) +
              ". Pass your own question only when the user asks about a specific object, text, region, or color.",
            default: GENERIC_QUESTION,
          },
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
