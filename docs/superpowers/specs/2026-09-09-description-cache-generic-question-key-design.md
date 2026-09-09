# 描述缓存泛解析统一 key，question 改可选

> 状态：定稿（2026-09-09，review 通过）
> 关联实现：`src/index.ts`、`test/plugin.test.ts`
> 关联文档：`README.md`、`README.zh.md`
> 上一版契约：`docs/superpowers/specs/2026-09-08-description-cache-persist-design.md`（存档只读）。
> 本档只改「泛解析类请求的缓存 key 语义」一处；LRU/容量/原子写/fail-open 等机制原样沿用，不回改旧档。

## 问题

缓存 key 是 `<图片sha256>:<question>`，其中 question 由主模型每次调用工具时自己编。同样一句话「解析[Image 1]」配同一张图，两个会话里主模型写出的 question 往往不一样，例如：

- 会话 A：`请完整描述这张图片的内容。如果包含文字，请逐字转录所有文字内容…`
- 会话 B：`请详细描述这张图片的全部内容：这是什么类型的截图/图表/流程图？…`

key 不一样，第二个会话就 miss，等于每会话各付一次视觉模型的钱。已经从会话库和磁盘缓存文件对账确认：两个缓存条目和两个 question 一一对应，读写逻辑本身没错，是 key 的粒度不合适。

缓存真正能命中的场景只有跨会话（同会话内工具输出本来就在上下文里，几乎不会重复调）。key 里塞自由文本，跨会话几乎不可能逐字一致，命中率趋近于零。要让它有意义，就得把「泛解析」这一类请求的 key 固定下来。

## 方案

泛解析请求（用户只让描述整张图，没问具体点）的 question 统一改成固定文案：

```
export const GENERIC_QUESTION =
  "Describe this image in full detail, including all text, UI elements, diagrams, or content visible."
```

这个文案同时是工具的 `question` 参数默认值（schema `default` 字段，空 question 时用它兜底），所以主模型能看到"不填时是什么"，两处天然对齐。点名文字/UI/图表/可见内容，是让视觉模型把整图信息带全。判断「这是不是泛解析」用精确匹配：去掉首尾引号、统一大小写和空白（含全角）、去掉末尾句点后，和 GENERIC_QUESTION 一致就算。不做模糊匹配、不收关键词表——误判会把针对性回答错误地套到泛解析上，宁可 miss 也不要错答。

改写后 key 仍是老格式 `<sha256>:<question>`，泛解析请求全部落在 `<sha>:Describe this image in full detail, including all text, UI elements, diagrams, or content visible.` 这一条上：

- 空 question / 省略 question / 各种措辞变体 → 同一 key，跨会话命中；
- 针对性追问（问具体对象/文字/区域/颜色）→ question 原样保留，key 与旧版本逐字节相同，存量条目不受影响。

不用裸 sha 当 key，理由：以后想改 GENERIC_QUESTION 的措辞，或想按用户/场景定制泛描述问题，只要问题文本变了 key 就自然分开，不会被历史缓存绑死；老条目成孤儿后由 LRU 按 mtime 清掉。本改动在 feature 分支、发版前落定文案，不存在老版本泛解析条目的迁移负担。

泛解析走 canonical 这条写入路径时加一道门槛：描述文本少于 100 字符不入缓存。canonical 要求整图加逐字转录，正常结果不可能这么短，短文本大概率是视觉模型敷衍或拒绝产出，存进去会毒化这一条，让以后所有泛解析都拿到垃圾描述。

## 配套改动

- `question` 参数语义改可选，且 schema 带 `default: GENERIC_QUESTION`、description 也写明默认串（防止运行时不透传 default 时模型看不到）。工具描述里原来写着 "question … be specific"，等于在鼓励主模型每次换措辞，跟目标对着干，删掉，改成「不填默认整图描述，问具体点才自己写」。提示词（chat.message 注入的 synthetic 文本）也补一句同样的话：泛解析不要填 question，问具体点才填。两层文案同一口径。
- 不引入 experimental 的系统提示改写钩子，也不加"查该图已有缓存问题"之类的工具。先用最小改动跑一阵，看命中率够不够，不够再加。
- `VISION_SYSTEM_PROMPT`（发给视觉子会话的那段）不动。

## 已知限制

- 泛解析结果恒以英文问题驱动产出，语言跟随 GENERIC_QUESTION，由主模型负责转述。
- GENERIC_QUESTION 措辞定了就是稳定契约，将来改动会弃掉旧的泛解析条目（交给 LRU 清理），这是刻意为之。
- 主模型不听话，泛解析还是自己编 question 时，会落到 specific 层产生新条目（多付一次钱），不产生错误答案。这个服从率要靠上面两条文案尽量拉高，是本次要实测的点。
- 换视觉模型不会自动重算泛解析描述；想要新描述，用非 canonical 的措辞触发一次即可。

## 行为描述

```
q      = args.question?.trim() || GENERIC_QUESTION
generic = isGenericQuestion(q)
if generic: q = GENERIC_QUESTION
key    = sha256(图片字节) + ":" + q
命中   → 返回缓存条目（title 带 cached）
miss   → describeWithChain(image, q)
         写盘时：generic 且 text 长度 < 100 字符 → 不写；其余照常
```

`GENERIC_QUESTION`、`normalizeQuestion`、`isGenericQuestion`、`genericWriteMinText` 都导出成模块级对象，测试可直接注入小值。

## 测试

- normalize/isGeneric 的纯函数用例（含"带着 canonical 句子但实际在追问细节"的句子必须判 false）。
- 泛解析跨两个独立插件实例收敛到同一条；specific 与 generic 互不串用。
- generic 短文本不落盘；specific 不受门槛影响。
- specific 的 key 与旧格式逐字节一致。
- 工具描述/hint 文案的契约断言。
- 既有描述缓存用例（LRU、超限、并发、损坏、失败语义）保持绿。

## 文档更新

- README / README.zh 的缓存语义段、已知限制，`src/index.ts` 头注释。
- 旧 spec 不回改，本行为以本档为准。
