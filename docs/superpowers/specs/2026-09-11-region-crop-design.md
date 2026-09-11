# 区域裁剪（放大查看图片细节）设计

> 状态：草稿（2026-09-11）。
> 关联实现文件：`src/index.ts`、`test/plugin.test.ts`、`test/helpers.ts`
> 关联文档：`README.md`、`README.zh.md`
> 参考实现：hermes-agent `tools/vision_tools.py`（`region` 参数 + Pillow 裁剪）、
>   QwenLM/qwen-code `packages/core/src/tools/zoom-image.ts`（归一化 0–1000 坐标）。
> supersede：无。

## 背景与动机

`vision_analyze` 目前只有"看整张图"一种粒度。视觉模型对大图会做内部降采样，
全屏截图里的细小文字、密集 UI、图表轴标签会被压糊，泛解析描述因此漏读或臆测。

本需求（README Roadmap 唯一剩余项「区域裁剪（放大查看图片细节）」）让主模型能指定
一个矩形区域，插件先把该区域从原图裁出来、再走后续降采样/编码，使小块独享完整分辨率
预算——等效于"放大"，细节得以看清。

## 决策

| 决策项 | 结论 |
|---|---|
| API 形态 | 在现有 `vision_analyze` 上加可选 `region` 参数（不拆独立工具） |
| 坐标约定 | 归一化 **0–1000 整数** `[x1,y1,x2,y2]`，相对原图显示方向，(0,0) 左上、(1000,1000) 右下 |
| 定位方式 | 只加 `region`（主模型估坐标），不做两阶段"视觉模型先定位返回 bbox" |
| 裁剪引擎 | 外挂命令 + 优雅降级（`magick`/`convert`/`ffmpeg`），保持零运行时依赖 |
| 上下文图 | aux 子会话发 `[裁剪图, 原图]`（原图复用已读字节，不额外调命令；过大则跳过） |
| EXIF 方向 | 零依赖做自动旋转对齐（纯 JS 解析 JPEG EXIF orientation + 引擎 auto-orient） |
| 缓存 key | 无 region 沿用旧格式；有 region 用原始归一化值 `r<x1>,<y1>,<x2>,<y2>` |

## 关键前提修正（评审发现）

**非 zod args 会被自动标为 required。** opencode 的 `legacyJsonSchema`
（`packages/opencode/src/tool/registry.ts`）对非 zod 参数返回
`required: Object.keys(properties)`，且 `parameters = Schema.Unknown`（无运行时校验）。
本插件用普通 JSON-Schema 对象，所以现状 `question` 已被误标必填；直接加 `region`
会让纯文本主模型每次幻觉一个裁剪区。

对策：注册 `tool.definition` 钩子，在运行时把 `vision_analyze` 的
`output.jsonSchema.required` 改写为 `["image_path"]`。`output` 是同一引用
（`plugin/index.ts` 的 `trigger` 逐个 hook 传入后返回），注册表随后读回该字段。
因 `jsonSchema` 未写入 TS 类型，实现用 cast + 存在性检测；万一字段缺失，靠哨兵兜底
（`region` 省略或 `[0,0,1000,1000]` 视为整图）保证不出错。

## 详细设计

### 1. 工具 API

- `region`：`array`，4 个整数 0–1000，可选。
- 哨兵：`region` 省略，或等于 `[0,0,1000,1000]` → 按无 region 处理。
- 更新工具 `description` 与 `onChatMessage` 注入提示，教学：
  先整图、再带 region 二次放大；省略 region=整图；坐标 0–1000 相对原图。

### 2. 裁剪引擎

- 候选链：`magick` → `convert`（**win32 剔除**，避免撞系统 `convert.exe`）→ `ffmpeg`。
  **不含 sips**（`sips -c` 只做居中裁剪，无偏移参数）。
- 探测：纯 JS 扫 PATH（win32 按 PATHEXT 补扩展名），找到后 best-effort 跑一次
  `<cmd> -version` 验证；进程级 memoize；单候选失败续试下一个。插件选项
  `crop_command` 可覆盖可执行文件名。
- 调用：`child_process.execFile(cmd, args, { timeout, signal: ctx.abort,
  killSignal: "SIGKILL", windowsHide: true })`，**不经 shell**（杜绝注入）。
  先等子进程退出再删临时文件（Windows 上打开中的文件不能删）。
- 命令模板（输出恒 PNG）：
  - magick/convert：`<in>[0] -auto-orient -crop WxH+X+Y +repage <out>.png`
  - ffmpeg：`-y -nostdin -hide_banner -loglevel error -i <in>
    -vf crop=W:H:X:Y -frames:v 1 -c:v png <out>.png`（保留默认 autorotate）
- 临时文件：`fs.mkdtemp` 建插件自有临时目录，随机文件名，`finally` 递归清理。
- 并发：纯 JS 信号量限制同时裁剪数（默认 2），避免打满 CPU 饿死事件循环。
- 可注入 seam：模块级可变对象持有"探测函数/执行函数"，测试注入 fake，不碰真二进制。

### 3. 尺寸嗅探 + EXIF 自动对齐（零依赖）

- 纯 JS `imageSize(bytes)` 解析 PNG IHDR / GIF LSD / JPEG SOF / WebP(VP8/VP8L/VP8X)
  取宽高；JPEG 额外解析 EXIF `Orientation`。
- orientation ∈ {5,6,7,8} → 交换宽高，返回**显示方向**尺寸。
- 引擎统一在显示方向裁剪：magick/convert 加 `-auto-orient`；ffmpeg 保留默认 autorotate。
- 解析失败 → 清晰报错，绝不猜尺寸。非 JPEG 默认 orientation=1。

### 4. 校验与映射

- 校验：4 个数值、落在 0–1000、`x1<x2 && y1<y2`。容忍浮点（`Math.round` 后校验），
  否则报错。
- 映射：`left=floor(x1/1000*W)`、`top=floor(y1/1000*H)`、`right=ceil(x2/1000*W)`、
  `bottom=ceil(y2/1000*H)`，再 clamp 到图像边界；零面积 → 报错并带上真实 `W×H`，
  便于主模型重试。

### 5. 处理流程

```
解析图片（URL 下载 / 路径原位读 / 缓存）→ loadImage bytes → imageSize（显示尺寸）
  → region 校验 + 映射（纯计算，不调外部命令）
  ├─ 快速路径（主模型有视觉）
  │    有 region → crop → 返回 [裁剪图] 单附件
  │    无 region → 现状（原图附件）
  └─ aux 路径
        key = 无 region ? `<sha>:<question>` : `<sha>:r<x1>,<y1>,<x2>,<y2>|<question>`
        查缓存 → 命中直接返回（不 crop）
        miss → crop → 子会话 parts = [裁剪图, 原图]（原图过大则跳过）
             → 候选链描述 → 落缓存 → 返回文本
```

- 裁剪**先于任何降采样**（放大本质）。
- 上下文图用原图（复用已读字节），不再单独跑一次降采样命令。

### 6. 缓存与门槛

- key：无 region 逐字节沿用旧格式，存量条目照常命中；有 region 用**原始归一化值**
  （非 clamp 后像素，避免尺寸变化漂移），格式 `r<x1>,<y1>,<x2>,<y2>`。
- 整图哨兵归一化为无 region key。
- 泛解析最短门槛：无 region 维持 100 字符；有 region 用小下限（默认 24，可注入），
  **不跳过**——region 条目同样跨会话共享，需防短垃圾毒化。

### 7. 结果披露

有 region 时结果文本附：裁剪区**原图像素**边界 `[x,y,w,h]`、原图显示尺寸 `W×H`，
以及"视觉模型报告的坐标相对裁剪原点，需加偏移才能回原图"（hermes `scale_note` 精神）。

### 8. 错误与降级

- 缺引擎 / 裁剪失败 / 超时 / 非法 region / 嗅探失败 → 全部返回可读错误文字，
  **不抛错**（沿用"工具永不抛错"契约）。
- 无 region 时行为与现状完全一致。

## 非目标

- 两阶段视觉定位（视觉模型先返回 bbox）。
- 引入 npm 运行时依赖。
- 持久化裁剪像素产物（临时文件即用即删）。
- URL 私网拦截（沿用既有决策不做）。
- sips 支持。
- 非 JPEG 的 EXIF 方向（默认 1，文档标注）。

## 测试

- `imageSize`：PNG/GIF/JPEG（含 EXIF orientation 1/6）/WebP 三子格式 fixture；
  截断/损坏 → 报错不猜。
- region 校验/映射：越界 clamp、floor/ceil、零面积报错含真实尺寸、哨兵、非法输入。
- `buildCropArgs`：各引擎 argv 正确（含 `-auto-orient`、PNG 输出、动图 `[0]`）。
- 引擎探测：win32 无 `convert`、PATHEXT、`-version` 验证、单候选失败续试。
- fake runner：成功、非零退出、超时、abort → 无 tmp 残留。
- 并发上限。
- `tool.definition` 钩子把 required 改写为 `["image_path"]`。
- 缓存 key：无 region 兼容、region 隔离、整图哨兵归一化。
- 门槛：region 小下限行为。
- 流程：快速路径单附件；aux parts 顺序 `[裁剪图, 原图]`。
- hint/description 含 region 契约。

## 文档

- `README.md` / `README.zh.md`：特性、工作原理、存储与缓存 key、Roadmap 勾选、
  已知限制（需自备 ImageMagick/ffmpeg；EXIF 自动对齐支持 JPEG）。
- `src/index.ts` 头注释同步。

## 边界与取舍

- 主模型估坐标可能不准：靠 clamp + 零面积报错带真实尺寸 + 结果披露，支持迭代重试。
- 归一化坐标相对原图而非上次裁剪结果，故可反复裁剪、无需坐标回映计算。
- 外部命令缺失时 region 不可用，但整图功能不受影响（优雅降级）。
- 原图作上下文图可能较大：设阈值，超过则只发裁剪图（不阻断分析）。
