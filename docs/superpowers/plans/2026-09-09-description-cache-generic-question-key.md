# 描述缓存泛解析统一 key，question 改可选：执行计划

> 日期：2026-09-09。关联 spec：`docs/superpowers/specs/2026-09-09-description-cache-generic-question-key-design.md`
> 分支：`feat/description-cache-generic-key`（基于 main @ 0.4.0）
> 门禁：`bun run typecheck && bun test && bun run build`。TDD：先写会失败的测试，再改源码。
> 交付后不自行 push / merge / 发版。
> 迭代内修订（review 反馈）：canonical 文案扩为点名文字/UI/图表/可见内容的完整句；question schema 增 `default: GENERIC_QUESTION`；chat.message hint 维持"省略 question"口径不动。

## 任务拆解

1. 建分支、写 spec/plan（本文档所在提交）。
2. 测试（红）：`test/plugin.test.ts`
   - import 增加 `GENERIC_QUESTION`、`normalizeQuestion`、`isGenericQuestion`、`genericWriteMinText`；`getAnalyze` 的 execute 参数类型把 `question` 改成可选。
   - 新增用例，见下方清单。
   - 运行 `bun test`，确认新增用例失败、其余通过。
3. 源码（绿）：`src/index.ts`
   - 导出 `GENERIC_QUESTION`、`genericWriteMinText = { chars: 100 }`、`normalizeQuestion`、`isGenericQuestion`。
   - `visionAnalyze` 内：默认串改引 `GENERIC_QUESTION`；按 isGeneric 改写 question；写盘处加 generic 最短长度门槛。
   - 工具 description / args.question 文案改可选，args.question 增加 `default: GENERIC_QUESTION` 且 description 写明默认串；chat.message hint 追加「泛解析省略 question」。
   - 运行 `bun test` 全绿。
4. 文档：README.md / README.zh.md 缓存段与已知限制；`src/index.ts` 头注释。
5. 门禁：`bun run typecheck && bun test && bun run build`。
6. 分逻辑 commit：docs → test(red) → src(green) → docs。
7. 交付 review（含议会验收 + 用户 checklist 验收）。

## 新增用例清单（测试块）

- `normalizeQuestion` / `isGenericQuestion`：
  - `isGenericQuestion("")`、GENERIC_QUESTION 原文 → true
  - 变体：带首尾引号、全大写、全角空格、缺末尾句点 → true
  - `"persist me"`、`"q1"`、`"small"`、`"who labels"` → false
  - 带 canonical 句子的针对性追问（例：`"Describe this image in full detail, including all text, UI elements, diagrams, or content visible, and read the error inside the red box."`）→ false
- e2e（复用 descPath 助手）：
  - 实例A 省略 question → `vision_analyze`、prompt 1、落盘 `descPath(GENERIC_QUESTION)`
  - 独立实例B 显式 `GENERIC_QUESTION` → `(cached)`、prompt 0
  - 独立实例C 传变体（大小写/空白）→ `(cached)`、prompt 0
  - generic 与 targeted 共存：两条互不串用，targeted 重复命中 `(cached)`
  - 门槛：注入 `genericWriteMinText.chars` 为很大的值（或小值验证相反方向），generic 得短文本不落盘；specific 不受影响
  - specific key 逐字节 = `sha256(\`${TINY_PNG_SHA}:${question}\`)`
- 契约：hint 文本含省略 question 的语义；工具 description 含 "Optional"，不含 "be specific"

## 验收标准

- [ ] 两个独立插件实例、同一张图、同为泛解析（省略/空/canonical 变体）→ 第二次 `(cached)` 且不再调视觉模型
- [ ] 针对性追问 key 与旧格式一致、可命中、不串用泛解析条目
- [ ] 泛解析短文本不落盘
- [ ] 既有描述缓存用例零改动零失败；typecheck/test/build 全绿
- [ ] 本迭代不引入 experimental 系统提示钩子、不加新工具
