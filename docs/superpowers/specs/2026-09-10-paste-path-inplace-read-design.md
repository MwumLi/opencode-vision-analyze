# 路径粘贴原位读用（免复制进 vision 缓存）设计

> 状态：草稿（2026-09-10）。
> 关联实现文件：`src/index.ts`、`test/plugin.test.ts`、`test/helpers.ts`
> 关联文档：`README.md`、`README.zh.md`
> supersede：无。

## 背景与动机

opencode TUI 的输入框粘贴处理（`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
的 `pasteInputText()`）会自动识别"粘贴内容是本地文件路径"：当路径指向 `image/*` 或
`application/pdf` 时，读取文件内容、base64 编码，并以 `file` 类型 part + `[Image N]` 虚拟
占位插入。该 part 带 `source` 字段：

```json
{ "type": "file", "path": "/tmp/snap-push/08b7...-image.png",
  "text": { "value": "[Image 1]", "start": 7, "end": 16 } }
```

- **路径粘贴**：`source.path` 是磁盘上真实存在的图片文件路径（如 snap-push 落盘文件、
  项目内相对路径 `img/foo.png`）。
- **复制图片本身**（截图/浏览器"复制图片"）：剪贴板里是像素而非路径，opencode 以
  `filename="clipboard"`、`source.path="clipboard"` 表示，磁盘上无对应文件。

当前插件的 `chat.message` 钩子对所有图片 part 一律把 base64 解码落盘到
`<cache>/opencode-vision-analyze/vision/<sha256>.<ext>`，再在 synthetic 提示里给模型一个
缓存路径。对"路径粘贴"而言，这是把用户磁盘上**已存在**的文件又复制了一份进缓存，造成：

1. 无意义的磁盘占用与缓存污染（用户已有该文件）；
2. 与 README 已声明的"本地已存在文件原位读用、不复制"语义不一致（该语义此前只在
   模型直接以路径调用 `vision_analyze` 时成立，钩子路径并未遵守）。

用户诉求：**路径粘贴免复制，原位读用；且同一路径每次粘贴都应分析文件的最新内容。**

## 决策

| 决策项 | 结论 |
|---|---|
| 路径解析优先级 | 新增 `resolveImagePath(part)`：有有效 `source.path` → 用源文件路径；否则回退 `persistImage`（现有落盘） |
| 判定条件 | `part.source.type === "file"` 且 `part.source.path` 非空 → 绝对化 → 扩展名 ∈ `EXT_MIME` → `fs.stat` 为存在且非空的普通文件 |
| 相对路径基准 | `path.isAbsolute(src.path) ? src.path : path.resolve(input.directory, src.path)`。与 opencode 工具一致（`tool/read.ts`、`tool/edit.ts` 用 `path.resolve(instance.directory, filepath)`） |
| 回退条件 | 无 `source` / `source.path` 非真实文件 / 扩展名不受支持 / `stat` 失败 → `persistImage` 落盘（复制图片本身等场景） |
| 防陈旧检查 | **不做**。粘贴瞬间到 hook 执行的窗口极小（核心刚读完文件），且真正的风险窗口（hook→工具调用）无法在 hook 内覆盖；接受"文件被改/删如实反映" |
| 最新内容保证 | 提示中给源文件**绝对路径**，`vision_analyze` 每次调用**当场重读**文件；描述缓存 key = `<内容sha256>:<问题>`，内容变化即 miss 重算。**无任何按路径的缓存** |
| 描述缓存 | 不变，继续落盘于 `<cache>/opencode-vision-analyze/descriptions`，按内容 sha 命中 |
| 图片缓存 | `vision/` 保留，继续服务"复制图片本身"与 URL 下载；LRU / 容量上限逻辑不变 |
| 失败语义 | 全链 fail-open：源路径判定失败即回退落盘；落盘失败仍返回 undefined（沿用现状），不阻断消息持久化 |

## 判定流程

```
onChatMessage → 收集 image parts
  └─ 每个 part: resolveImagePath(part)
       ├─ source.type==="file" && source.path 非空
       │    ├─ 绝对化（相对 → path.resolve(input.directory, path)）
       │    ├─ 扩展名 ∈ EXT_MIME ?
       │    │    ├─ 否 → persistImage(part)
       │    │    └─ 是 → fs.stat(abs)
       │    │         ├─ isFile() && size>0 → 用 abs（不落盘）
       │    │         └─ 失败 / 空文件 → persistImage(part)
       │    └─ 无 source.path → persistImage(part)
       └─ persistImage：base64 解码 → 内容寻址落盘 <sha256>.<ext>
```

## 非目标

- `image_path` 支持 `data:` URL 输入。
- 即时描述（hook 内直接调视觉模型、取消 `vision_analyze` 工具）。
- "复制图片本身"（剪贴板位图）免落盘（需内存/会话消息回退，属另一方案）。
- 修改 opencode 核心的路径自动识别行为。
- 防陈旧的大小/哈希校验。

## 测试

`test/helpers.ts`：`imagePart()` 增加可选参数以注入 `source`。

`test/plugin.test.ts`（`chat.message 钩子` describe）：

1. **绝对路径命中**：`dir` 下建真实图片，part 带 `source.path=abs` → hint 含该绝对路径，且 `vision/` 下无内容寻址文件。
2. **相对路径命中**：`source.path="sub/x.png"`（`dir/sub/x.png` 真实存在）→ hint 含 `path.resolve(dir, "sub/x.png")`，不落盘。
3. **源文件不存在** → 回退落盘（hint 用内容寻址路径）。
4. **扩展名不支持**（如 `foo.bin` 真实存在）→ 回退落盘。
5. **无 `source`**（复制图片本身）→ 维持落盘（现有用例）。
6. **最新内容回归**：先落盘一张图并记录 sha；修改源文件内容后经 hook 注入的源路径调 `vision_analyze`，断言子会话 prompt 收到的是**新内容**的 base64、且描述缓存按新 sha 重算。

## 文档

- `README.md` / `README.zh.md`「工作原理 / 存储与缓存」：路径粘贴（有 `source.path`）原位读、
  不复制，始终分析文件最新内容；仅"复制图片本身"与 URL 下载落盘。
- `src/index.ts` 头注释同步。

## 边界与取舍

- 源文件在"粘贴 → 工具调用"之间被删/改：会被如实反映（改则分析新内容，删则
  `Image not found`）。这是"不复制"的预期代价，符合"始终分析最新内容"的诉求。
- 相对路径基准固定为 `input.directory`（当前项目目录）；若基准不符导致 `stat` 失败，
  最坏退化为旧行为（落盘一份），不报错。
- `vision/` 缓存继续存在，服务于非路径来源的图片；本次不改变其 LRU / 容量语义。
