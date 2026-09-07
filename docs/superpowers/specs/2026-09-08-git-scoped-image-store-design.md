# 图片存储按 git 语义分域（git → 项目 / 非 git → 用户缓存）设计

> 状态：定稿（2026-09-08，用户 review 通过并实现）。
> 关联实现文件：`src/index.ts`、`test/plugin.test.ts`、`test/helpers.ts`
> 关联文档：`README.md`、`README.zh.md`、`docs/superpowers/specs/2026-09-05-opencode-vision-analyze-design.md`

## 背景与动机

现状：图片一律落盘到 `input.directory/.opencode/vision/<sha256>.<ext>`（src/index.ts 下载路径与
贴图持久化两处）。痛点：在 /tmp、一次性/非 git 目录里贴图会留下带图片的目录；而 opencode 平台
本身对「独立项目」的定义是 **git repo = 独立项目，非 git 目录的会话归全局**（官方文档 + issues
佐证：非 git 目录 session 的 `project_id = "global"`）。社区想把非 git 目录提升为独立项目的呼声
（anomalyco/opencode#15192）很小且已被官方 **Closed as not planned**，近期语义不会松动。

本设计让插件图片存储与 opencode 的项目/全局心智对齐：**git 项目内 → 项目目录；非 git 目录 →
用户级共享缓存目录**，从而在临时/非 git 目录贴图不再留下项目目录残渣。

## 决策

| 决策项 | 结论 |
|---|---|
| 判定依据 | 从 `input.directory` 向上逐级找 `.git`（**目录或文件**，覆盖 worktree/submodule）直至文件系统根；命中即视为 git 项目 |
| git 项目存储 | `<input.directory>/.opencode/vision`（现状，零行为变更；即使 0 commit 也按 git 处理——比 opencode 当前"需有提交"更宽，落在 #15192 提议方向上，且避免依赖外部 git 命令） |
| 非 git 存储 | 用户级缓存：Linux `$XDG_CACHE_HOME\|\|~/.cache`；macOS `~/Library/Caches`；Windows `%LOCALAPPDATA%\|\|~/AppData/Local` → 追加 `opencode-vision-analyze/vision`；`mkdir` 用 `0o700` |
| 配置入口 | **不新增选项**：纯自动规则，目录解析收敛为单点函数，便于将来按需扩展显式覆盖 |
| 写盘原子性 | 共享目录下多进程/多实例并发写同 sha：先写临时文件再 `rename`（内容寻址幂等，防撕裂） |
| 失败语义 | 沿用 fail-open：落盘失败只是少了 vision_analyze 提示，不影响消息入库；目录解析为纯同步、无网络 |
| 迁移 | 不自动迁移历史目录；文档注明旧 hint 里的绝对路径在切换后 stale，重贴即可 |

## 非目标

- 不做描述缓存落盘持久化（进程内存 Map，独立 Roadmap 项：按内容 sha 落盘 + LRU/容量）。
- 不新增 `vision_dir` 等显式配置选项。
- 不做跨平台目录的 `~` 展开/其它魔法（无配置面）。

## 详细行为

### 检测 git（纯函数，可注入）
```
isInsideGitRepo(dir):
  cur = dir
  loop:
    p = join(cur, ".git")
    若 p 是目录 或 p 是文件（worktree/submodule 的 "gitdir: ..." 指针）→ true
    cur = dirname(cur)
    到文件系统根仍未命中 → false
```

### 目录解析（纯函数，可注入 platform/env/homedir，供三平台单测）
```
resolveVisionDir(inputDir, env, platform, homedir):
  isInsideGitRepo(inputDir) == true
    → join(inputDir, ".opencode", "vision")
  else
    base = 平台 cache 根（见决策表）
    → join(base, "opencode-vision-analyze", "vision")   // mkdir 0o700
```

### 落盘写入（下载 / 贴图统一收敛到同一目录解析结果）
- 计算 `sha256`；目标文件 `<sha><ext>`。
- 写入临时文件 `<sha><ext>.tmp-<randomUUID>` → `rename` 到目标（同目录原子替换）。
- mkdir 失败/写失败：沿用既有 fail-open 语义（贴图返回 undefined 跳过；下载返回错误文字）。

### 运行影响
- 图片消费全部在本进程内（磁盘读 → base64 data URL → 子会话/附件），目录放用户级**无跨主机可见性问题**。
- 描述缓存是进程内存 Map，本次改动不带来跨项目 API 节省（那是描述缓存落盘的事）。
- 跨项目同字节图片在用户级目录可复用（内容寻址免费去重），收益为 MB 级磁盘 + git 干净度。

## 测试计划（TDD 先行）

helpers：
- `makeTempDir()` 创建临时目录后**同时创建空 `.git` 目录** → 既有测试默认保持「项目级」，全部既有断言零改动、不写真实用户 home。

plugin.test 新增：
1. `isInsideGitRepo`：根目录 `.git` 目录命中；子目录向上命中；`.git` 为**文件**（worktree）命中；无 `.git` 返回 false。
2. `resolveVisionDir`（注入 env/platform/homedir）：git → `inputDir/.opencode/vision`；非 git → 三平台用户缓存根（含 XDG_CACHE_HOME / LOCALAPPDATA 覆盖分支）。
3. 端到端（非 git 目录 + 临时 XDG_CACHE_HOME，测试内设置并还原 env）：chat 贴图后图片落在 `$XDG_CACHE_HOME/opencode-vision-analyze/vision/<sha>.png`，hint 的 image_path 指向该处。
4. 端到端（git 目录 = 带 `.git` 的临时目录）：贴图落在 `dir/.opencode/vision/<sha>.png`（回归，等价现状）。
5. 并发写同 sha：两次并发写同一 sha → 最终文件完整（rename 原子）。

## 文档更新

- README.md / README.zh.md：说明图片目录语义（git 项目 → 项目 `.opencode/vision`；非 git 目录 →
  用户级缓存 `…/opencode-vision-analyze/vision`）；建议 git 项目把 `.opencode/vision/` 加入 `.gitignore`；
  注明切换后旧 hint 路径失效、重贴即可。Roadmap 现有「LRU/size cap for description cache」扩展为
  「按内容 sha 落盘持久化描述缓存（含 LRU/容量，独立立项）」。
- `2026-09-05-…design.md`：落盘决策行更新 + 追加 2026-09-08 变更记录行。

## 验证门禁

```
bun run typecheck && bun test && bun run build
```
全绿为准；既有用例零 diff。
