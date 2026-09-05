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
| 回退 | 视觉调用失败/超时 → 返回友好错误文字（工具永不 throw），原图仍由核心 unsupportedParts 机制降级 |
| 落盘 | `.opencode/vision/<sha256>.<ext>` 内容寻址，跨会话天然去重 |
| 缓存 | 描述按 `<图片sha256>:<问题>` 缓存，同图同问题只描述一次 |
| 递归防护 | 视觉模型自身的消息（子会话 prompt）不注入提示、不落盘 |
| 范围 | 仅用户附图 + http(s) 图片 URL；仅 V1 会话流 |

## 架构与数据流

```
用户发消息(带图) → chat.message 钩子（消息持久化前）
  1. 记录 sessionID → 当前模型（供工具快速路径判定）
  2. 递归防护：input.model 是视觉模型 → 直接返回
  3. 收集 image file parts；无图返回
  4. 能力门控：主模型有视觉 → 返回（原图直发）
  5. 每图落盘（sha256 内容寻址）+ 注入 synthetic 提示 part：
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
  ├─ 描述缓存命中 → 直接返回
  └─ describeImage：创建子会话（parentID 挂当前会话、不进会话列表、
       不生成标题、tools 全禁、专用 system prompt）
       → 视觉模型描述 → finally 删除子会话 → 返回描述文字
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

## Roadmap

见 [README Roadmap](../README.zh.md#roadmap)。
