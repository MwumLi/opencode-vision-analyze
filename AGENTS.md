# opencode-vision-analyze 开发约定

## 版本与发布流程

- 版本变更一律用 `npm version <ver>`（自动更新 package.json + commit + 打 annotated tag `v<ver>`），
  **禁止手改 package.json 的 version 字段**。
- 已配置两个生命周期钩子，`npm version` 即一步 ship：
  - `preversion`：先跑 `typecheck && test && build` 本地门禁，任一失败则不 bump / 不 commit / 不打 tag
  - `postversion`：`git push --follow-tags` 自动推送 commit + tag → 触发 `release.yml`（`on.push.tags: ["v*"]`）→ npm publish
- 发布走 GitHub Actions，需仓库 secret `NPM_TOKEN`（npm Automation token）；release.yml 内先跑
  typecheck/test/build/smoke 再 publish，发布自带 CI 双保险。

### 常用命令

```bash
npm version minor              # 新功能：0.5.0 → 0.6.0，commit + tag v0.6.0，自动推送发布
npm version patch              # 修 bug：0.1.x → 0.1.(x+1)，commit + tag v0.1.x，自动推送发布
npm version 1.2.0              # 显式指定完整版本
npm version prerelease --preid beta   # beta 冒烟：0.1.1 → 0.1.2-beta.0
```

### beta 冒烟 → 正式（两段式）

```bash
# 1) 发 beta：自动推送并触发 beta 版发布到 npm
npm version prerelease --preid beta
# 2) 在 npm 上验证 beta 无误后，转正式（npm 会自动去掉 pre 段并 bump）
npm version patch
```

### 逃逸舱

- `npm version 1.2.3 --no-git-tag-version`：只改 package.json 版本，不 commit / 不 tag / 不触发 postversion
- `npm version 1.2.3 --ignore-scripts`：跳过 preversion / version / postversion 全部钩子

### 注意事项

- `npm version` 要求工作区干净：有未提交改动会拒绝执行（先 commit 或 stash）。
- `postversion` 的 push 若失败（网络/凭据），版本已 bump 但未推送：手动补
  `git push --follow-tags` 即可。
- 0.x 阶段：新功能用 `npm version minor`（或显式版本号），修 bug 用 `patch`；**不要用 `major`**（会从 0.x 直接跳到 1.0.0）。

## 测试

- `bun test`（单元测试，stub client，无需运行 opencode）；`bun run typecheck`；`bun run build`。

## 文档与存档约定

- 已定稿的历史 spec/plan（`docs/superpowers/specs|plans/`）属**历史存档，只读**：
  除该文档自身所在的那一次迭代内（同一迭代、未合入）外，**不再修改**。
- 新需求/迭代一律以**新日期命名**的 spec（`docs/superpowers/specs/YYYY-MM-DD-*.md`）与 plan 落盘；
  确需关联旧文档时只加链接引用，不回改旧文、不在旧档头部叠注释。
- 单次迭代内对新产生的 spec/plan 可正常修改直至定稿；定稿/合入后即冻结为存档。
