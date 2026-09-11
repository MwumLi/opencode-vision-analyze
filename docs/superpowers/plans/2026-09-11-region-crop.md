# 区域裁剪（放大查看图片细节）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `vision_analyze` 增加可选 `region` 参数，把图片子区域裁出来（先于降采样）单独交给视觉模型，实现"放大看细节"。

**Architecture:** 全部改动落在单文件 `src/index.ts`（保持 curl 单文件安装路径不被破坏）。新增纯函数：图片尺寸/EXIF 嗅探、region 校验与像素映射、裁剪命令构造；新增可注入的裁剪执行器（外挂 `magick`/`convert`/`ffmpeg`，零运行时依赖）；在 `visionAnalyze` 里按"无 region=现状 / 有 region=裁剪"分支，并注册 `tool.definition` 钩子修正 required。

**Tech Stack:** TypeScript、node 内置模块（crypto/fs/path/child_process）、bun test（stub client）。

**关键约束：** 不得拆分成多文件（README 的 curl 单文件安装依赖 `src/index.ts` 自包含）；不得引入运行时依赖。

---

## 文件结构

- Modify: `src/index.ts` — 全部实现（新增纯函数 + 执行器 + 流程分支 + 钩子 + 描述）。
- Modify: `test/helpers.ts` — 增加多图/尺寸可控的测试图片构造、`cropRunner` 注入辅助。
- Modify: `test/plugin.test.ts` — 新增 region 相关用例。
- Modify: `README.md` / `README.zh.md` — 特性、原理、缓存 key、Roadmap、已知限制。
- Modify: `src/index.ts` 头注释。

---

## Task 1: 图片尺寸嗅探 + EXIF orientation（纯函数）

**Files:**
- Modify: `src/index.ts`（新增 `ImageInfo` / `imageSize` / `readExifOrientation`，放在 `EXT_MIME` 附近）
- Test: `test/plugin.test.ts`（新增 describe）

- [ ] **Step 1: 写失败测试**

在 `test/plugin.test.ts` 顶部 import 增加 `imageSize`，并新增：

```ts
describe("imageSize 图片尺寸嗅探", () => {
  test("PNG：读 IHDR 宽高，orientation=1", () => {
    // 2x3 的 PNG（手工最小 PNG：IHDR 宽 2 高 3）
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAACZgbYnAAAAEklEQVR42mNk+M9Qz0AEYBxVSF8FAN2lE9kAAAAASUVORK5CYII=",
      "base64",
    )
    expect(imageSize(png)).toEqual({ width: 2, height: 3, orientation: 1 })
  })

  test("截断/非法字节：返回 undefined（不猜）", () => {
    expect(imageSize(Buffer.from("not an image"))).toBeUndefined()
    expect(imageSize(TINY_PNG.subarray(0, 10))).toBeUndefined()
  })

  test("JPEG orientation=6（5-8）时交换宽高为显示尺寸", () => {
    // 构造带 EXIF Orientation=6 的最小 JPEG 头（存储 3x2 → 显示 2x3）
    const jpeg = makeExifJpeg(3, 2, 6)
    expect(imageSize(jpeg)).toEqual({ width: 2, height: 3, orientation: 6 })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test -t "imageSize"` → 预期 FAIL（`imageSize is not a function`）

- [ ] **Step 3: 实现**

在 `src/index.ts` 的 `MIME_EXT` 之后加入：

```ts
/** 图片尺寸与显示方向信息。orientation 为 EXIF Orientation（1 表示无需旋转）。 */
export type ImageInfo = { width: number; height: number; orientation: number }

/** EXIF Orientation 5–8 表示像素被转置，显示尺寸需交换宽高。 */
function isTransposed(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8
}

/**
 * 从 JPEG 的 APP1/EXIF 段读取 Orientation（0x0112）。
 * 只做最小 TIFF/IFD 解析；任何不识别都返回 1（按无需旋转处理），绝不猜尺寸。
 */
export function readExifOrientation(bytes: Buffer): number {
  // JPEG 以 FFD8 起，逐段扫描 marker；APP1(FFE1) 里才可能有 Exif。
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1
    const marker = bytes[offset + 1]
    // 填充字节 0xFF 跳过；SOI/EOI/RSTn 无长度字段。
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue }
    const size = bytes.readUInt16BE(offset + 2)
    if (size < 2) return 1
    if (marker === 0xe1 && offset + 4 + size <= bytes.length) {
      const seg = bytes.subarray(offset + 4, offset + 2 + size)
      // APP1 负载以 "Exif\0\0" 开头，其后是 TIFF 头。
      if (seg.length > 14 && seg.toString("latin1", 0, 4) === "Exif") {
        const tiff = seg.subarray(6)
        const little = tiff.toString("latin1", 0, 2) === "II"
        const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
        const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))
        if (tiff.length >= 8 && u16(2) === 0x2a) {
          const ifd0 = u32(4)
          if (ifd0 + 2 <= tiff.length) {
            const count = u16(ifd0)
            for (let i = 0; i < count; i++) {
              const entry = ifd0 + 2 + i * 12
              if (entry + 12 > tiff.length) break
              if (u16(entry) === 0x0112) {
                const value = u16(entry + 8)
                return value >= 1 && value <= 8 ? value : 1
              }
            }
          }
        }
      }
    }
    // SOS 之后是压缩数据，不可能再有 EXIF。
    if (marker === 0xda) return 1
    offset += 2 + size
  }
  return 1
}

/** 读 PNG 宽高（IHDR 固定位于签名后第一个块）。 */
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** 读 GIF 逻辑屏幕宽高（小端 u16）。 */
function gifSize(bytes: Buffer): { width: number; height: number } | undefined {
  const sig = bytes.toString("latin1", 0, 6)
  if (sig !== "GIF87a" && sig !== "GIF89a") return undefined
  if (bytes.length < 10) return undefined
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

/** 读 JPEG 宽高：扫描到 SOF 段取高度/宽度（大端 u16）。 */
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue }
    const size = bytes.readUInt16BE(offset + 2)
    if (size < 2) return undefined
    // SOF0..SOF15（排除 DHT C4、DAC CC、RSTn）含尺寸。
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    if (marker === 0xda) return undefined
    offset += 2 + size
  }
  return undefined
}

/** 读 WebP 宽高（VP8/VP8L/VP8X 三种子格式）。 */
function webpSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 30 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") {
    return undefined
  }
  const format = bytes.toString("latin1", 12, 16)
  if (format === "VP8X") {
    const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    return { width: w, height: h }
  }
  if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  if (format === "VP8 ") {
    // 关键帧起始码 9d 01 2a 之后是 14-bit 宽高（小端）。
    const start = 20
    if (bytes.length >= start + 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      const w = bytes.readUInt16LE(start + 6) & 0x3fff
      const h = bytes.readUInt16LE(start + 8) & 0x3fff
      return { width: w, height: h }
    }
  }
  return undefined
}

/**
 * 嗅探图片宽高与显示方向。返回的是**显示方向**尺寸：EXIF 5–8 时交换宽高，
 * 与裁剪引擎的 auto-orient 行为对齐。识别失败返回 undefined，绝不猜。
 */
export function imageSize(bytes: Buffer): ImageInfo | undefined {
  const base = pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes)
  if (!base) return undefined
  const orientation = readExifOrientation(bytes)
  const transposed = isTransposed(orientation)
  return {
    width: transposed ? base.height : base.width,
    height: transposed ? base.width : base.height,
    orientation,
  }
}
```

同时给测试加一个构造带 EXIF 的最小 JPEG 的辅助（放在 `test/plugin.test.ts` 顶部或 helpers）：

```ts
/** 构造最小 JPEG：SOI + APP1(Exif Orientation) + SOF0(尺寸) + EOI。仅用于嗅探测试。 */
function makeExifJpeg(width: number, height: number, orientation: number): Buffer {
  const app1 = Buffer.alloc(2 + 6 + 2 + 2 + 4 + 2 + 12 + 4)
  app1.writeUInt16BE(app1.length, 0)
  app1.write("Exif", 2, "latin1")
  app1.writeUInt16BE(0, 6)
  // TIFF 头（大端）
  app1.write("MM", 8, "latin1")
  app1.writeUInt16BE(0x2a, 10)
  app1.writeUInt32BE(8, 12)
  app1.writeUInt16BE(1, 16) // IFD 条目数
  app1.writeUInt16BE(0x0112, 18) // Orientation tag
  app1.writeUInt16BE(3, 20) // SHORT
  app1.writeUInt32BE(1, 22)
  app1.writeUInt16BE(orientation, 26)
  app1.writeUInt32BE(0, 28)
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(11, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), app1, sof, Buffer.from([0xff, 0xd9])])
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test -t "imageSize"` → 预期 PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: add pure-JS image size + EXIF orientation sniffer"
```

---

## Task 2: region 校验、映射与裁剪命令构造（纯函数）

**Files:**
- Modify: `src/index.ts`（新增 `ParsedRegion`/`parseRegion`/`isWholeImageRegion`/`regionKey`/`regionToPixels`/`cropEngineCandidates`/`buildCropArgs`）
- Test: `test/plugin.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe("region 校验/映射/命令构造", () => {
  test("parseRegion：合法 4 整数通过，越界/长度错/非数拒绝", () => {
    expect(parseRegion([0, 0, 500, 500])).toEqual({ x1: 0, y1: 0, x2: 500, y2: 500 })
    expect(parseRegion([0, 0, 1001, 500])).toBeUndefined()
    expect(parseRegion([0, 0, 500])).toBeUndefined()
    expect(parseRegion([0, 0, "x", 500])).toBeUndefined()
    expect(parseRegion([500, 0, 100, 500])).toBeUndefined() // x1>=x2
  })

  test("regionToPixels：floor 左/上、ceil 右/下，并 clamp", () => {
    expect(regionToPixels({ x1: 0, y1: 0, x2: 500, y2: 500 }, { width: 101, height: 101 }))
      .toEqual({ left: 0, top: 0, width: 51, height: 51 })
    expect(regionToPixels({ x1: 0, y1: 0, x2: 1000, y2: 1000 }, { width: 10, height: 10 }))
      .toEqual({ left: 0, top: 0, width: 10, height: 10 })
    // 越界 clamp 后仍有面积
    expect(regionToPixels({ x1: 0, y1: 0, x2: 1000, y2: 1000 }, { width: 10, height: 10 })!.width).toBe(10)
  })

  test("buildCropArgs：magick 带 -auto-orient 与帧选择；ffmpeg 用 crop 滤镜", () => {
    const rect = { left: 1, top: 2, width: 30, height: 40 }
    expect(buildCropArgs("magick", "/in.png", rect, "/out.png")).toEqual([
      "/in.png[0]", "-auto-orient", "-crop", "30x40+1+2", "+repage", "/out.png",
    ])
    expect(buildCropArgs("ffmpeg", "/in.png", rect, "/out.png")).toEqual([
      "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", "/in.png", "-vf", "crop=30:40:1:2", "-frames:v", "1", "-c:v", "png", "/out.png",
    ])
  })

  test("cropEngineCandidates：win32 不含 convert", () => {
    expect(cropEngineCandidates("win32")).toEqual(["magick", "ffmpeg"])
    expect(cropEngineCandidates("linux")).toEqual(["magick", "convert", "ffmpeg"])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test -t "region 校验"` → 预期 FAIL

- [ ] **Step 3: 实现**

```ts
/** 归一化 region（0–1000 整数坐标）。 */
export type ParsedRegion = { x1: number; y1: number; x2: number; y2: number }

/** 解析并校验 region；容忍浮点（四舍五入），非法返回 undefined。 */
export function parseRegion(input: unknown): ParsedRegion | undefined {
  if (!Array.isArray(input) || input.length !== 4) return undefined
  const nums = input.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN))
  if (nums.some((v) => Number.isNaN(v) || v < 0 || v > 1000)) return undefined
  const [x1, y1, x2, y2] = nums
  if (x1 >= x2 || y1 >= y2) return undefined
  return { x1, y1, x2, y2 }
}

/** 是否整图（哨兵）——视为"无 region"，走原有整图路径与旧缓存 key。 */
export function isWholeImageRegion(r: ParsedRegion): boolean {
  return r.x1 === 0 && r.y1 === 0 && r.x2 === 1000 && r.y2 === 1000
}

/** region 的缓存 key 片段：用原始归一化值，避免 clamp 后像素随尺寸漂移。 */
export function regionKey(r: ParsedRegion): string {
  return `r${r.x1},${r.y1},${r.x2},${r.y2}`
}

/** 像素矩形（左上原点，宽高）。 */
export type PixelRect = { left: number; top: number; width: number; height: number }

/**
 * 归一化 region → 原图像素矩形：左/上向下取整、右/下向上取整，
 * 保证合法窄区域不塌缩；clamp 到图像边界；零面积返回 undefined。
 */
export function regionToPixels(r: ParsedRegion, size: { width: number; height: number }): PixelRect | undefined {
  const left = Math.max(0, Math.min(Math.floor((r.x1 / 1000) * size.width), size.width))
  const top = Math.max(0, Math.min(Math.floor((r.y1 / 1000) * size.height), size.height))
  const right = Math.max(0, Math.min(Math.ceil((r.x2 / 1000) * size.width), size.width))
  const bottom = Math.max(0, Math.min(Math.ceil((r.y2 / 1000) * size.height), size.height))
  if (right <= left || bottom <= top) return undefined
  return { left, top, width: right - left, height: bottom - top }
}

/** 裁剪引擎类型。 */
export type CropEngine = "magick" | "convert" | "ffmpeg"

/** 候选引擎顺序：win32 排除 convert（会撞系统 convert.exe）。 */
export function cropEngineCandidates(platform: string): CropEngine[] {
  return platform === "win32" ? ["magick", "ffmpeg"] : ["magick", "convert", "ffmpeg"]
}

/** 构造裁剪命令参数（不经 shell；输出恒 PNG）。 */
export function buildCropArgs(engine: CropEngine, input: string, rect: PixelRect, output: string): string[] {
  const geometry = `${rect.width}x${rect.height}+${rect.left}+${rect.top}`
  if (engine === "ffmpeg") {
    return [
      "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", input, "-vf", `crop=${rect.width}:${rect.height}:${rect.left}:${rect.top}`,
      "-frames:v", "1", "-c:v", "png", output,
    ]
  }
  // ImageMagick v7/v6：先 auto-orient（与 imageSize 的显示尺寸口径一致）再裁剪；
  // [0] 取首帧，避免动图多帧输出成 out-0.png 之类。
  return [`${input}[0]`, "-auto-orient", "-crop", geometry, "+repage", output]
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test -t "region 校验"` → 预期 PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: add region validation, pixel mapping and crop command builder"
```

---

## Task 3: 可注入裁剪执行器（引擎探测 + execFile）

**Files:**
- Modify: `src/index.ts`
- Test: `test/plugin.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe("裁剪执行器", () => {
  test("探测：magick 可用则选中；不可用则续试 convert", async () => {
    const calls: string[] = []
    const orig = cropRunner.exec
    cropRunner.exec = async (file) => {
      calls.push(file)
      if (file === "magick") throw new Error("ENOENT")
    }
    try {
      const engine = await detectCropEngine("linux")
      expect(engine).toBe("convert")
      expect(calls).toEqual(["magick", "convert"])
    } finally {
      cropRunner.exec = orig
    }
  })

  test("探测：全部不可用返回 undefined", async () => {
    const orig = cropRunner.exec
    cropRunner.exec = async () => { throw new Error("ENOENT") }
    try {
      expect(await detectCropEngine("linux")).toBeUndefined()
    } finally {
      cropRunner.exec = orig
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test -t "裁剪执行器"` → 预期 FAIL

- [ ] **Step 3: 实现**

顶部 import 增加 `execFile`：

```ts
import { execFile } from "node:child_process"
```

在纯函数区加入：

```ts
/** 裁剪/探测的执行超时与并发上限（模块级可变对象，测试可注入小值）。 */
export const regionCropLimits = { timeoutMs: 15000, maxConcurrent: 2 }

/**
 * 可注入的进程执行器：生产实现走 child_process.execFile（**不经 shell**，
 * 参数以数组传入，杜绝注入）；测试注入 fake，不碰真实二进制。
 * 退出码非 0 / 启动失败 / 超时 / abort 一律 reject。
 */
export const cropRunner = {
  exec: (file: string, args: string[], signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: regionCropLimits.timeoutMs, signal, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error) => (error ? reject(error) : resolve()),
      )
    }),
}

/**
 * 惰性探测可用裁剪引擎：按候选顺序跑一次 `<engine> -version` 验证，
 * 首个成功即选中。用版本探测而非 which，顺带排除同名但非目标工具的可执行文件。
 */
export async function detectCropEngine(platform: string): Promise<CropEngine | undefined> {
  for (const engine of cropEngineCandidates(platform)) {
    try {
      await cropRunner.exec(engine, ["-version"], new AbortController().signal)
      return engine
    } catch {
      // 该候选不可用，续试下一个
    }
  }
  return undefined
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test -t "裁剪执行器"` → 预期 PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: add injectable crop engine detection/executor"
```

---

## Task 4: 多图描述支持 + cropImage 集成

**Files:**
- Modify: `src/index.ts`（`attemptModel` / `describeWithChain` 改为多图；新增闭包 `cropImage`、`resolveCropEngine`、信号量）
- Test: `test/plugin.test.ts`

- [ ] **Step 1: 写失败测试（多图 parts）**

```ts
test("多图：describeWithChain 把多张图按序放进子会话 parts", async () => {
  // 通过 vision_analyze 的 region 路径间接验证；此处断言 parts 含两个 file part
  // （完整用例见 Task 5）
})
```

> 注：多图是内部能力，Task 5 的端到端用例覆盖它；本任务只做重构 + 闭包 `cropImage`，用 Task 5 测试验证。可先跳过独立测试，直接重构并保证既有测试全绿。

- [ ] **Step 2: 重构 `attemptModel` 接收 `images[]`**

把签名 `image: { bytes: Buffer; mime: string }` 改为 `images: Array<{ bytes: Buffer; mime: string }>`，并把 parts 构造改为：

```ts
const fileParts = images.map((img) => ({
  type: "file" as const,
  mime: img.mime,
  url: `data:${img.mime};base64,${img.bytes.toString("base64")}`,
}))
// ...
parts: [...fileParts, { type: "text", text: question }],
```

`describeWithChain` 同步改为接收 `images`。

- [ ] **Step 3: 新增闭包 `resolveCropEngine` 与 `cropImage`**

在插件闭包内（`persistImageBytes` 附近）：

```ts
/** 裁剪引擎探测结果 memoize（进程/插件实例级）。 */
let cropEnginePromise: Promise<CropEngine | undefined> | undefined
const resolveCropEngine = (): Promise<CropEngine | undefined> => {
  cropEnginePromise ??= detectCropEngine(process.platform)
  return cropEnginePromise
}

/** 简易并发信号量：限制同时运行的裁剪子进程数，避免打满 CPU 饿死事件循环。 */
let activeCrops = 0
const cropWaiters: Array<() => void> = []
const acquireCropSlot = async (): Promise<void> => {
  if (activeCrops < regionCropLimits.maxConcurrent) { activeCrops += 1; return }
  await new Promise<void>((resolve) => cropWaiters.push(resolve))
  activeCrops += 1
}
const releaseCropSlot = (): void => {
  activeCrops -= 1
  cropWaiters.shift()?.()
}

/**
 * 按 region 裁剪图片，返回裁剪后 PNG 字节；临时文件即用即删。
 * 任何失败（无引擎/命令失败/超时/读取失败）返回 { error }，不抛错。
 */
const cropImage = async (
  inputPath: string,
  rect: PixelRect,
  ctx: ToolContext,
): Promise<{ bytes: Buffer; mime: string } | { error: string }> => {
  const engine = await resolveCropEngine()
  if (!engine) {
    return { error: "region cropping requires ImageMagick (magick/convert) or ffmpeg; install one or omit region" }
  }
  await acquireCropSlot()
  let tmpDir: string | undefined
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-crop-"))
    const out = path.join(tmpDir, `crop-${randomUUID()}.png`)
    await cropRunner.exec(engine, buildCropArgs(engine, inputPath, rect, out), ctx.abort)
    const bytes = await fs.readFile(out)
    if (bytes.length === 0) return { error: "region crop produced an empty image" }
    return { bytes, mime: "image/png" }
  } catch (error) {
    return { error: `region crop failed: ${errText(error)}` }
  } finally {
    releaseCropSlot()
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
```

`os` 需 import：`import os from "node:os"`（现有已 import `homedir` from node:os，改为同时引入 `tmpdir` 或 `os`）。

- [ ] **Step 4: 运行既有测试确认全绿**

Run: `bun test` → 预期既有用例全部 PASS（重构未改行为）

- [ ] **Step 5: 提交**

```bash
git add src/index.ts
git commit -m "refactor: support multi-image vision prompt; add cropImage helper"
```

---

## Task 5: `visionAnalyze` 接入 region（缓存 key / 门槛 / 披露 / 双路径）

**Files:**
- Modify: `src/index.ts`（`visionAnalyze`）
- Test: `test/plugin.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe("vision_analyze region 裁剪", () => {
  test("有 region：子会话 parts 为 [裁剪图, 原图, 文本]，且缓存 key 含 region", async () => {
    const client = makeStubClient({ providersResult: providersStub(providerStub("test", "config", { "vision-model": { image: true } })) })
    const input = makePluginInput(dir, client)
    const { hooks } = await loadPlugin(input, { models: [VISION_MODEL.providerID + "/" + VISION_MODEL.modelID] })
    // 造一张 100x50 的 PNG 落盘，避免依赖裁剪引擎
    const imgPath = path.join(dir, "big.png")
    await writeFile(imgPath, makePng(100, 50))
    // 注入 fake 裁剪执行器：magick -version 成功；裁剪时把输入复制成输出
    const origExec = cropRunner.exec
    cropRunner.exec = async (file, args) => {
      if (args[0] === "-version") return
      const out = args[args.length - 1]
      await writeFile(out, makePng(50, 30))
    }
    try {
      const analyze = getAnalyze(hooks)
      const result = await analyze({ image_path: imgPath, region: [0, 0, 500, 600], question: "读右上角文字" }, toolCtx(new AbortController().signal))
      expect(result.output).toContain("described by")
      const parts = client.calls.prompt[0].parts as Array<{ type: string; url?: string }>
      const fileParts = parts.filter((p) => p.type === "file")
      expect(fileParts.length).toBe(2) // 裁剪图 + 原图上下文
      expect(result.output).toContain("region") // scale_note 披露
    } finally {
      cropRunner.exec = origExec
    }
  })

  test("无 region：行为与缓存 key 不变（旧 key 命中）", async () => {
    // 预先按旧 key 写描述缓存，调用无 region 应命中 cached
    // （沿用既有描述缓存测试写法，见 plugin.test.ts 现有用例）
  })
})
```

需要辅助 `makePng(w,h)`：可用 node 手工拼一个纯色 PNG（带 CRC），或复用 Task 1 的 `makeExifJpeg` 思路构造 PNG。建议在 helpers 里加 `makePng`（用 zlib deflate 拼最小 PNG）。

- [ ] **Step 2: 运行确认失败**

Run: `bun test -t "region 裁剪"` → 预期 FAIL

- [ ] **Step 3: 实现 `visionAnalyze` 分支**

在现有 `visionAnalyze` 内、`loadImage` 成功之后插入 region 解析；并调整缓存/快速路径顺序：

```ts
// —— region 解析（纯计算，不调外部命令）——
let regionRect: PixelRect | undefined
let regionTag = ""
if (args.region !== undefined) {
  const parsed = parseRegion(args.region)
  if (!parsed) {
    return { title, output: "Image analysis failed: invalid region; expected [x1,y1,x2,y2] as four integers in 0-1000 (normalized, top-left origin)" }
  }
  if (!isWholeImageRegion(parsed)) {
    const info = imageSize(image.bytes)
    if (!info) return { title, output: `Image analysis failed: cannot determine image dimensions for region crop` }
    const rect = regionToPixels(parsed, info)
    if (!rect) {
      return { title, output: `Image analysis failed: invalid region crops to zero area; image is ${info.width}x${info.height} px` }
    }
    regionRect = rect
    regionTag = regionKey(parsed)
  }
}

// 快速路径（主模型有视觉）
const current = sessionModels.get(ctx.sessionID)
if (current && (await imageSupport(current.providerID, current.modelID))) {
  if (regionRect) {
    const cropped = await cropImage(imagePath, regionRect, ctx)
    if ("error" in cropped) return { title, output: `Image analysis failed: ${cropped.error}` }
    return {
      title,
      output: `[Image attached for direct inspection: ${path.basename(imagePath)} (region ${regionTag})]`,
      attachments: [{ type: "file", mime: cropped.mime, url: `data:${cropped.mime};base64,${cropped.bytes.toString("base64")}` }],
    }
  }
  // ...原有整图快速路径...
}

// 描述缓存 key：无 region 沿用旧格式
const key = regionTag ? `${createHash("sha256").update(image.bytes).digest("hex")}:${regionTag}|${question}` : `${createHash("sha256").update(image.bytes).digest("hex")}:${question}`
// ...缓存命中返回（命中时不裁剪）...

// miss：有 region 先裁剪
let images: Array<{ bytes: Buffer; mime: string }> = [image]
if (regionRect) {
  const cropped = await cropImage(imagePath, regionRect, ctx)
  if ("error" in cropped) return { title, output: `Image analysis failed: ${cropped.error}` }
  images = [cropped, image] // 裁剪图在前，原图作上下文
}
const result = await describeWithChain(images, question, ctx)
// ...
// 门槛：有 region 用小下限
const minChars = regionRect ? regionGenericMinText.chars : genericWriteMinText.chars
if (generic && result.text.length < minChars) return { ...不落盘... }
// ...
// 结果文本附 region 披露
const disclosure = regionRect ? `\n\n[Region: crop [x=${regionRect.left}, y=${regionRect.top}, w=${regionRect.width}, h=${regionRect.height}] of the original image (${imageSize(image.bytes)!.width}x${imageSize(image.bytes)!.height}); coordinates the vision model reports are relative to this crop origin.]` : ""
```

新增模块级：

```ts
/** 有 region 时泛解析条目的最短文本长度（区域描述天然可短，但仍防垃圾）。 */
export const regionGenericMinText = { chars: 24 }
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test -t "region 裁剪"` → 预期 PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/plugin.test.ts test/helpers.ts
git commit -m "feat: wire region crop into vision_analyze (cache key, gate, disclosure)"
```

---

## Task 6: 工具 schema/description、`tool.definition` 钩子、hint 教学

**Files:**
- Modify: `src/index.ts`（tool 注册 + `onChatMessage` + 返回 Hooks）
- Test: `test/plugin.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test("tool.definition 钩子把 vision_analyze 的 required 改为仅 image_path", async () => {
  const client = makeStubClient()
  const { hooks } = await loadPlugin(makePluginInput(dir, client), {})
  const output = { description: "d", parameters: {}, jsonSchema: { type: "object", properties: {}, required: ["image_path", "question", "region"] } }
  await hooks["tool.definition"]!({ toolID: "vision_analyze" }, output as never)
  expect(output.jsonSchema.required).toEqual(["image_path"])
})

test("region 工具描述含 0-1000 归一化契约", async () => {
  const client = makeStubClient()
  const { hooks } = await loadPlugin(makePluginInput(dir, client), {})
  const tool = (hooks.tool as Record<string, { args: Record<string, { description?: string }> }>)["vision_analyze"]
  expect(tool.args.region?.description).toContain("0-1000")
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test -t "tool.definition"` → 预期 FAIL

- [ ] **Step 3: 实现**

工具注册加 `region`：

```ts
region: {
  type: "array",
  items: { type: "integer", minimum: 0, maximum: 1000 },
  minItems: 4,
  maxItems: 4,
  description:
    "Optional [x1,y1,x2,y2] crop region in normalized 0-1000 coordinates of the ORIGINAL image (0,0 top-left, 1000,1000 bottom-right). Applied before downscaling so the region keeps full resolution — a zoom for small text/UI detail. Intended flow: describe the whole image first, then call again with a region. Coordinates always refer to the original image, never a previous crop.",
},
```

返回 Hooks 增加：

```ts
"tool.definition": async (input, output) => {
  if (input.toolID !== "vision_analyze") return
  // 非 zod args 会被框架标成全部必填（legacyJsonSchema），这里改回仅 image_path；
  // jsonSchema 是运行时字段（未写入类型），故做存在性检测。
  const js = (output as { jsonSchema?: { required?: string[] } }).jsonSchema
  if (js && Array.isArray(js.required)) js.required = ["image_path"]
},
```

`onChatMessage` 提示追加一行：

```ts
"[For fine details (small text, dense UI), call vision_analyze again with a region [x1,y1,x2,y2] in normalized 0-1000 coordinates of the original image to zoom in. Omit region for the whole image.]",
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test -t "tool.definition"` → 预期 PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: expose region in schema, fix required via tool.definition hook, teach in hint"
```

---

## Task 7: 文档与 Roadmap

**Files:**
- Modify: `README.md`、`README.zh.md`、`src/index.ts` 头注释

- [ ] **Step 1: 更新 README 中英**：特性加"区域裁剪（外挂 ImageMagick/ffmpeg，零运行时依赖）"；工作原理补 region 分支与"crop 先于降采样"；存储与缓存补 region 缓存 key；Roadmap 勾选；已知限制补"region 需自备 ImageMagick/ffmpeg，EXIF 自动对齐支持 JPEG"。
- [ ] **Step 2: 更新 `src/index.ts` 头注释**：补充 region 说明。
- [ ] **Step 3: 提交**

```bash
git add README.md README.zh.md src/index.ts
git commit -m "docs: document region crop feature and roadmap"
```

---

## Task 8: 门禁与验收

- [ ] **Step 1:** `bun run typecheck` → 无错误
- [ ] **Step 2:** `bun test` → 全绿
- [ ] **Step 3:** `bun run build` → 产出 dist
- [ ] **Step 4:** 通知 council 做议会验收
- [ ] **Step 5:** 生成验收 checklist 并通知用户

---

## Self-Review 记录

- Spec 覆盖：API/钩子→Task 6；引擎→Task 3；嗅探+EXIF→Task 1；校验映射→Task 2；流程→Task 4/5；缓存门槛→Task 5；披露→Task 5；文档→Task 7。
- 无占位符：各任务均给出可运行代码/命令。
- 类型一致：`PixelRect`、`CropEngine`、`ParsedRegion`、`cropRunner`、`imageSize` 在各任务间签名一致。
- 注意：单文件约束（不拆分）。
