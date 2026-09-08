# 图片存储按 git 语义分域 — 实施计划

> 供实现者逐 Task 执行。行为契约以 spec 为准：
> `docs/superpowers/specs/2026-09-08-git-scoped-image-store-design.md`。
> 硬性要求：新增/修改代码必须带必要中文注释、符合阅读习惯；每 Task 结束跑 `bun test`；
> 全部 Task 结束跑 `bun run typecheck && bun test && bun run build` 且全绿；按 Task 提交 git、蓝信通知。

**Goal**: 图片存储自动分域——git 项目内 → 项目 `.opencode/vision`（现状不变）；非 git 目录 →
用户级缓存目录；不新增配置选项。

**Architecture**: 单文件插件 `src/index.ts` 收敛目录解析为两个纯函数（可注入测试）+ 一个闭包常量；
两处落盘改用该常量；`test/helpers.ts` 让测试目录带 `.git` 以保持既有路径断言。

**Tech Stack**: TypeScript / bun test；零运行时依赖（新增 `node:os`，仍仅内置模块）。

---

## 文件映射

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/index.ts` | 改 | +node:os；纯函数 `isInsideGitRepo`/`resolveVisionDir`（命名导出）；目录解析一次；两处落盘改常量；临时文件+rename |
| `test/helpers.ts` | 改 | `makeTempDir` 内创建空 `.git` 目录 |
| `test/plugin.test.ts` | 改 | 新增 git 检测/目录解析/端到端/并发写用例 |
| `README.md`、`README.zh.md` | 改 | 存储语义说明 + gitignore 建议 + Roadmap 措辞 |
| `docs/superpowers/specs/2026-09-08-git-scoped-image-store-design.md` | 改 | 定稿（去草稿状态行） |

---

## Task 1：helpers 测试目录带 git 标记

**Files**: `test/helpers.ts`

- Step 1: `makeTempDir()` 返回目录后，在目录内创建空 `.git` 目录。
- Step 2: 跑 `bun test`，既有用例应全绿（路径断言不变）。
- commit: `test: mark stub project dirs as git repos`

## Task 2：目录解析纯函数 + 两处落盘收敛

**Files**: `src/index.ts`、`test/plugin.test.ts`

- Step 1（红）：新增用例 —— `isInsideGitRepo`（.git 目录/.git 文件/子目录向上/无 git/根边界）；
  `resolveVisionDir` 三平台 × env 覆盖；非 git 端到端（临时 XDG_CACHE_HOME）落到用户缓存。
- Step 2: 确认新增失败。
- Step 3（绿）：实现两个命名导出纯函数 + 加载期 `const visionDir = resolveVisionDir(...)`；
  下载/贴图两处改用 `visionDir`；写盘改为临时文件+rename；docstring 与注释同步。
- Step 4: 全量 `bun test` 绿、`bun run typecheck` 绿、`bun run build` 绿。
- commit: `feat(storage): scope image store to project when in git repo, else user cache`

## Task 3：并发写原子回归

**Files**: `test/plugin.test.ts`

- Step 1（红）：并发写同一 sha 两次 → 断言最终文件字节完整、无中间态残留。
- Step 2: 确认实现经 rename 后通过；`bun test` 全绿。
- commit: `test(storage): concurrent same-sha writes are atomic`

## Task 4：文档同步

**Files**: `README.md`、`README.zh.md`、本 spec

- Step 1: README 中英存储语义 + gitignore 建议 + 旧 hint stale 说明；Roadmap 描述缓存落盘措辞；
  本 spec 状态行已定稿。**不回改历史 spec**（只读存档）。
- Step 2: `bun run typecheck && bun test && bun run build` 最终全绿。
- commit: `docs: document git-scoped image storage and roadmap persistent description cache`

## 验证门禁

```
bun run typecheck && bun test && bun run build
```
既有用例零 diff（helpers 的 `.git` 标记保持项目级路径）。
