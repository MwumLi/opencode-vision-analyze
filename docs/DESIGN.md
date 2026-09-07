# opencode-vision-analyze 设计文档

> 本文档是插件的设计决策与机制说明存档，面向维护者。面向使用者的文档见 [README](../README.zh.md)。

## 目标

为「不具备视觉能力的主模型」提供图片解读路由能力：

- 主模型无视觉：模型自主调用 `vision_analyze` 工具，由专用视觉模型描述图片，描述文字直接进入对话
- 主模型有视觉：贴图原样直发，插件零干预；工具短路返回原图
- 提交零阻塞：与"提交前预分析"方案相反，采用工具化方案（模型自己决定何时看图、带什么问题看），失败在 agent 循环里可见、可重试

## 设计决策

| 决策项 | 结论 |
|---|---|
| 架构 | 工具化（而非预分析）：提交即时，模型自主调用 `vision_analyze` |
| 分发 | npm 包 + curl 单文件双通道（零运行时依赖使 curl 直用成为可能） |
| 门控 | 主模型 `capabilities.input.image` 为真 → 不注入提示（`config.providers()` 查询，进程级缓存） |
| 原生快速路径 | 有视觉模型调用工具时直接返回 `attachments`（原图），零辅助调用 |
| 候选链归一化 | `model`（单字符串，等价 `models:["x"]`）/ `models`（有序数组）/ 均缺 → 统一归一化成一个有序候选数组：显式项恒在链首、不受档序影响；显式为空 → 整链 = 自动发现（全部 image-capable 模型）；二者并存报错 |
| 运行时单一路径 | 候选链一旦定型，运行时不再感知任何配置开关：`describeWithChain` 沿链逐候选 `attemptModel`，成功即止 / abort 中止整链 / 全败聚合各候选原因 |
| fallback 构建期语义 | `unlisted_fallback` 是纯构建期开关：只在 `resolveChain()` 组装链时消费（显式链 ++ 未列出的 image-capable 模型），链定型后执行零分支 |
| 发现排序 | 自动/fallback 部分按 `Provider.source` 档位稳定排序（档内保持 `config.providers()` 返回顺序；source 缺失/未知归档3）：默认 `config > env/api > custom`；`free_first=true` 时档序整体反转（custom/匿名免费优先） |
| 失败语义 | 候选失败/超时/中止 → 聚合可读错误文字（工具永不 throw），原图仍由核心 unsupportedParts 机制降级 |
| 落盘 | `.opencode/vision/<sha256>.<ext>` 内容寻址，跨会话天然去重 |
| 缓存记录 modelId | 描述缓存键 `<图片sha256>:<问题>`、值 `{ modelId, text }`：命中标签沿用入库时的 modelId，不随当前候选链链首变化而重写 |
| 递归防护（整链） | 防护集 = 候选链全体成员：描述子会话使用的任意候选模型的消息（prompt）都不再处理，不注入、不落盘 |
| 空链降级 | 显式/自动均无 image-capable → 插件正常加载（自动模式）；`vision_analyze` 返回友好错误、不建子会话；chat.message 带图不注入 hint、不落盘（避免制造无人消费的落盘文件） |
| 免登录可用性 | 自动发现与 `/models` 选择器同源（`config.providers()`）：免登录可见可用的 zen free 视觉模型同样被发现（provider 为 `custom` 源 → 默认档3；`free_first: true` 或显式 `opencode` provider 块可提前） |
| 范围 | 仅用户附图 + http(s) 图片 URL；仅 V1 会话流 |

## 架构与数据流

```
用户发消息(带图) → chat.message 钩子（消息持久化前）
  1. 记录 sessionID → 当前模型（供工具快速路径判定）
  2. 收集 image file parts；无图返回
  3. 递归防护：input.model ∈ 候选链 → 直接返回（resolveChain 懒加载 memoized）
  4. 能力门控：主模型有视觉 → 返回（原图直发）
  5. 空链降级：resolveChain 为空 → 返回（不注入 hint，交核心默认处理）
  6. 每图落盘（sha256 内容寻址）+ 注入 synthetic 提示 part：
     "[The user attached an image: <文件名>]"
     "[Examine it with the vision_analyze tool using image_path: <路径>]"
     （synthetic：TUI 隐藏、模型可见）

主模型处理：
  ├─ 有视觉：直接看原图 part（零成本）
  └─ 无视觉：核心 unsupportedParts 把图转 ERROR 引导文字 + 插件提示
       → 模型调用 vision_analyze 工具

vision_analyze 工具：
  ├─ image_path 是 http(s) URL → 下载（扩展名校验 / 20MB 双重上限 / 30s 超时）
  │    → 落盘同一 vision 目录 → 统一磁盘加载
  ├─ 原生快速路径：会话主模型有视觉 → 返回 attachments 原图
  ├─ 描述缓存命中 → 用缓存 { modelId, text } 打标签返回
  └─ describeWithChain：候选链为空 → 友好错误，不建子会话；否则沿链逐候选：
       create 子会话（parentID 挂当前会话、不进会话列表、tools 全禁、
       专用 system prompt）→ 用该候选模型描述 → finally delete 子会话
       → 成功：写缓存 { modelId, text }、以实际 modelId 打标签返回
       → 失败：记录 `${providerID}/${modelID}: <reason>` 并推进下一候选
       → abort（pre-aborted 或运行中）立即中止整链；全败聚合原因
```

## 关键机制依据

以下机制均基于 opencode 插件 API 的实际行为（实现时逐一验证）：

- **chat.message 同引用注入**：钩子的 `output.parts` 与持久化数组同引用，push 的 synthetic part 会随消息一并入库；part id 需满足 `prt_` 前缀
- **synthetic 双面性**：synthetic text part 在 TUI 隐藏但会发给模型——正是提示注入所需
- **核心自带降级**：无视觉模型收到图片 part 时，核心 `unsupportedParts` 自动转为明确 ERROR 引导文字，插件无需重复处理
- **插件工具注册**：非 zod 的 JSON-Schema 形式参数走注册表兼容路径；`execute` 收到完整 `ToolContext`（sessionID/directory/abort）
- **工具附件**：`ToolResult.attachments` 支持回传图片，核心按 provider 能力自动处理
- **子会话语义**：`parentID` 挂当前会话 → 不进会话列表、跳过标题生成；`tools: {"*": false}` → 权限 deny-all
- **能力查询**：`client.config.providers()` 返回 `models[id].capabilities.input.image`；瞬时失败（data 为空）不缓存，避免把一次网络故障固化成"永久无视觉"

## 错误处理原则

- **钩子 fail-open**：图片落盘失败（EACCES/ENOSPC）只影响提示注入，绝不阻断用户消息持久化
- **工具永不 throw**：所有失败路径返回可读错误文字（`Image analysis failed: ...` / `Image download failed: ...`），agent 循环可读到原因并自行决策
- **子会话用后即删**：`finally` 删除 + `dispose` 兜底清理异常路径残留
- **超时与中止**：`withDeadline` 以 Promise.race 保护子会话调用（超时 + abort 信号），pre-aborted 信号立即拒绝；timer/listener 在 finally 清理

## 已知限制

见 [README 已知限制](../README.zh.md#已知限制)，此处补充维护者视角：

- **model 未显式指定**：依赖默认模型的调用（SDK/TUI 首条消息）可能拿不到 `input.model`，门控退化（按无视觉处理，多注入一次提示），不影响正确性
- **能力查询无超时**：`config.providers()` 为进程内请求，实际挂起风险低
- **孤儿回合计费**：超时/中止后子会话被删除，但 provider 端已发出的请求不取消；可在删除前调用 `/session/{id}/abort` 改善
- **描述缓存无上限**：进程级 Map，按 (图, 问题) 对数增长
- **dispose 非确定性**：孤儿清理为尽力而为，无确定性测试覆盖
- **自动发现失败不重试**：`config.providers()` 查询失败会使进程内自动链为空（`resolveChain` 的 memoize 把空结果留在进程内，之后不再重试），显式链不受影响；仅记一行 `console.error` 日志可观测

## Roadmap

见 [README Roadmap](../README.zh.md#roadmap)。
