---
name: daily-review
description: >-
  Read one day's work timeline and write a short narrative review (今日复盘) in chat.
  Use this skill whenever the user explicitly asks to review a day — triggers include
  "今日复盘", "复盘一下今天", "复盘 11 月 6 号", "帮我复盘下今天", "daily review",
  "review today", "recap my day" — even when they only name a date and say 复盘.
  It is explicit-only: never offer it proactively, never suggest it at session end,
  and never start just because the timeline looks busy or empty. It never creates,
  updates or deletes events itself; the only write side effect is one whole-source
  sync up front, then event listing. For filling timeline gaps use yesterday-recall;
  for logging one just-finished task use summarize-event; for arbitrary date ranges,
  weeks or report data use weekly-reporter (wrp events); for authoring a weekly
  report final use writing-weekly-report.
---

今日复盘是把某一天已经落在时间线上的一切读成一条故事线的镜头：先全量同步一次把当天的提交补齐，再把手动事件和自动事件一起蒸馏成几条带时段锚点的成果 bullet，配上少量观察与明日待办，直接输出在对话里。它纯只读——时间线是素材，复盘只是读法。

三个技能各管一段：记录一段刚完成的工作 = **summarize-event**；补记过去某天的缺口 = **yesterday-recall**；阅读某一天 = **daily-review**。

## 边界与触发

- **仅显式触发。** 只有用户明确说要复盘某一天时才运行。不要主动 offer，不要在会话结束时提醒，也不要因为时间线很满或很空就自行启动；用户没说要复盘，就什么都不做。
- **日期语义。** 默认是字面意义上的「今天」（运行当天的本地日历日）。用户点名日期就照用，解析成 `YYYY-MM-DD`；不做周一补周末、节后补假期之类的自动扩展。
- **只读。** 本技能绝不调用 `events create` / `events update` / `events delete`。唯一有写副作用的前置是 `sources sync --all`——用户主动调用复盘即视为授权这次同步，因为它只是把已有提交补进时间线，不改任何人工内容。
- **不适用。** 补时间线的缺口 → **yesterday-recall**；记录刚完成的一段工作 → **summarize-event**；浏览任意日期范围、周级查询或按标签查事件 → **weekly-reporter（wrp events）**；写周报终版 → **writing-weekly-report**。

## 前置

- 数据访问统一走 **weekly-reporter（wrp）**：入口 `node <weekly-reporter>/scripts/wrp.mjs <module> <verb> [args]`（`<weekly-reporter>` 指代 weekly-reporter 技能目录）。本技能只用 `wrp sources sync` 与 `wrp events list`。路径解析：优先用同级已部署技能 `~/.claude/skills/weekly-reporter`（软链至 `~/.agents/skills/weekly-reporter`）；不存在则用仓库内 `skills/weekly-reporter/`。
- 事件列表的 `#<id>` 行、分页提示与空态语义见 weekly-reporter 的 `references/events.md`；`sources sync --all` 的结果行、部分失败与自动禁用语义见 `references/sources.md`。这里不复述，输出对不上时先查那两份文档。
- wrp 用内置 `fetch`（Node 18+），从环境变量（`WEEKLY_REPORTER_PAT`；`WEEKLY_REPORTER_BASE_URL` 或别名 `WEEKLY_REPORTER_URL`）或 `~/.config/weekly-reporter/auth.json` 读取凭据，base URL 默认 `http://localhost:6868`。任何 `/api/**` 调用返回 401 时，让用户在会话里运行 `! node <weekly-reporter>/scripts/wrp.mjs init` 配置 PAT，再重试。

## 工作流

### 1 — 全量同步

```bash
node <weekly-reporter>/scripts/wrp.mjs sources sync --all
```

本地 git 源的时间线不会在用户敲代码时自动刷新，不先同步就会漏掉当天最后几小时的提交，复盘也就缺了最新的一截。一次 `--all` 覆盖所有已启用源，比逐个源同步更省事。

成功后 wrp 打印基线行，例如 `✓ sources synced: 31/31 — 211 commits scanned, 0 new events`。`0 new events` 是正常的，表示各源都已是最新，不是漏采。

`sync --all` 之后时间线即最新；运行时点晚于最后一条事件属正常，尾段静默如实写进观察（例如「11:33 后时间线安静下来」），无需声明「数据截至」。

部分失败时 wrp 打印 `✗ partial sync failure (N/M sources failed): …`，其余源已经同步成功。**不中断**，照常复盘，在输出末尾加一行注记：`注：#N <name>、#M <name> 未能同步，复盘基于现有数据`——把**全部**失败源都列出来，读者才知道这份复盘缺了哪几块。

### 2 — 查询

```bash
node <weekly-reporter>/scripts/wrp.mjs events list --date <D> --limit 200
```

- **不带 `--source`。** 手动和自动一起取——复盘要的是完整的一天，不是某一类事件。
- 若 footer 显示满 200 条并出现 `next page: --cursor <id>@<epoch-millis>`，按提示用 `--cursor` 翻页取全（整段 cursor 照抄即可）。复盘要报数字和时段，漏一页会让结论失真。
- 空态由 wrp 打印显式空态行并退出 `0`，这不是错误；按下面的「空与稀薄数据」处理。

### 3 — 蒸馏

按「蒸馏规则」把当天所有事件嚼成几条成果 bullet。这一步决定了复盘有没有信息量：事件是原料，bullet 是读者能记住的东西。

### 4 — 组装

按「输出风格」拼出标题、bullet 故事线、**观察**、**明天**四部分。时段锚点必须回查事件的真实时间。

### 5 — 输出

默认直接输出到对话。**仅当**用户明确给了文件路径或说了「存档 / 保存」时才写文件，写到用户点名的路径；默认不问、不写——用户要的是对话里的那份复盘，不是仓库里多出来的一个文件。

## 蒸馏规则

- **手动与自动一视同仁。** 采集源事件和手动事件之间没有必然关联：同一段时间线里可能是两摊互不相干的事，也可能手动事件正是某组提交的结论。都当素材，不做「自动是正文、手动是补充」的预设。
- **单元 = nameable accomplishment。** 一行能命名的 shipped / fixed / decided 才成条。同一件事的系列提交、以及描述同一件事的手动事件，合并成一个 bullet；互不相干的各成一条。
- **跨分支重复提交必须合并。** 内容相同或几乎相同、时间相近的自动事件（同一提交被 rebase、cherry-pick，或同名分支各推一次），只出现一次。重复 bullet 会让读者高估当天的工作量。
- **项目归属从内容推断。** 提交信息的 ticket 前缀（`MMOA-*`、`MMCL-*`）、conventional-commit 的 scope、仓库名都是线索。`events list` 的来源列展示的是**源类型** `[manual]` / `[git-local]`，**不含具体源名**；`--source` 的过滤值则是 `manual|auto`，两者不是一回事，且本技能不带 `--source`。所以归属只能靠文本判断；判断不出就不写项目名，不要编。
- **★ 保留。** 手动事件在对应 bullet 行首留一个 ★，读者一眼就能看出哪条有人工判断的痕迹。
- **数字要数得出来。** 票号个数、提交条数都从事件里数，不夸大、不虚构；数不清就不写数字。「全天 N 条」类数字用**原始事件条数**（未去重）；提及重复时可写「其中 X 组跨分支重复」。
- **排序。** bullet 按各簇首个事件的时间升序排列，让故事线顺着时间读下去。

## 输出风格

标题写成 `# 今日复盘 · <YYYY-MM-DD>（周X）`；复盘历史日期时把「今日」换成「复盘」。正文是无标题的 bullet 故事线，后接 `**观察**` 与 `**明天**` 两个小节。

- 中文、无主语、一行一事。读者是用户本人，不需要「我」。
- 每条 bullet 以时段锚点开头：凌晨 / 清晨 / 上午 / 午前 / 午后 / 傍晚 / 晚上 + `HH:MM` 或 `HH:MM–HH:MM`（紧挨着上一条、同一时段里的小事可以只写 `HH:MM`）。时段要从事件的实际起止推出来，**不许把跨度外的事项塞进错误的时段**——读者会拿它对时间线。
  时段锚点的宽松分界：凌晨≈6 点前、清晨≈6–7:30、上午≈7:30–10、午前≈10–12、午后/下午≈12–18、傍晚≈18–19、晚≈19 后；锚点词求自然，精确度由 bullet 自带的 `HH:MM` 承载，紧贴上一条、同一时段的小事可只写 `HH:MM`。
- **观察** 2–3 条：只写数据撑得住的——节奏（哪段密集、哪段安静）、构成（提交与手动事件的占比、票号数）、模式（同一项目连续推进、频繁切换）、遗留。零手动事件、明显空档这类事实自然写进这里，并可顺势提一句 summarize-event（今天）或 yesterday-recall（过去日）——这是提示分流，不是自动补录。
- **明天** 1–3 条：从事件里能看出的未完成事项、被推迟的活、值得补录的空白。没有就少写，不要凑。
- 语气自然有人味，避免 AI 腔：不堆排比，不反复用「收口 / 收尾」这类词，不写「又是充实的一天」之类空话总结。任何一句删掉不影响信息的，就删掉。

基准样例（照这个密度和口吻写）：下面这份是**冻结的真实样例（golden）**——只用于对齐密度、结构和口吻，每次运行必须从实时时间线重新蒸馏，绝不可复用样例文本或数字。

```markdown
# 今日复盘 · 2026-11-09（周一）

- 凌晨 04:24 起，一头扎进 wrp 单入口客户端：两小时里八个模块从零建齐，三个旧技能移植、七个被替代技能退役，06:36 以一批加固修复收官（weekly-reporter）
- 上午 07:34–08:21，weekly-reporter 技能域收尾：yesterday-recall 入库、write-weekly-report 更名为 writing-weekly-report
- 上午 07:41–08:21，零售库存对账定稿：GLOSSARY 词条重写为快照/漂移模型、ADR 晋级 spec，负数钳零三链路落地，漂移重置与重进推送带测试收口（MMCL-1221–1225）
- 07:43，MMOA 设计规范 A 组 16 项一致性修复先落地（office-automation）
- 上午 09:56，顺手把 headplane API key 创建命令补进 headscale README
- 午前 10:10–11:33，MMOA 设计规范总攻：a11y 批次、token 统一、字号/断点/宽度定档，「今日已解决」筛选与处理人列上线，附件 staged 上传、合同页降级兜底（office-automation）

**观察**

- 全天 77 条提交、零手动事件：一天三摊事全靠流水说话，没有一条人工蒸馏留痕
- 凌晨到午前一气呵成，11:33 后时间线安静下来
- MMOA 一天推进 12 个票号，设计规范批次集中落地

**明天**

- 渠道库存存量清理 runbook 待执行（11-04 遗留）
- 值得补一条手动事件，把 wrp 客户端工程蒸馏成一条成果
```

（以上为 golden 样例，所有日期、数字、时段与项目名都来自样例当天，仅作格式参照。）

### 空与稀薄数据

- **0 条事件**：诚实报空，一句话说「<日期> 时间线上没有任何事件」，再加分流提示（今天 → summarize-event；过去日 → yesterday-recall）。**不要**输出框架式的空壳复盘——空标题、空观察、硬凑的「明天」只会让读者以为漏了数据。
- **少量自动事件**：照常复盘，只是 bullet 少一些；「观察」可以点出手动缺位（例如「全天 3 条提交、零手动事件」），不要为了填满三节而重复同一条事实。

## 错误处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `✗ partial sync failure (N/M sources failed)` | 部分采集源失败，其余已同步 | 不中断，继续复盘，输出末尾加一行注记，点名失败的源 |
| `✗ Cannot reach weekly-reporter` | 服务未启动或 base URL 不对 | 无法查询，照 wrp 的 ✗ 行原样转述并停止，不要用缓存或记忆编造复盘 |
| `unauthorized (HTTP 401)` | PAT 缺失、失效或撤销 | 让用户运行 `! node <weekly-reporter>/scripts/wrp.mjs init`，再重试 |
| `SOURCE_BUSY: 该仓库正在操作中` | 另一同步或抓取持锁 | 等几秒重试一次；仍失败就跳过同步，基于现有数据复盘并在末尾注记 |
| footer 出现 `next page: --cursor …` | 当天超过 200 条 | 用提示里的 cursor 翻页取全再蒸馏 |
| events list 空态行 | 当天确实没有事件 | 按「空与稀薄数据」处理，不报错、不造内容 |

## 不要做的事

- 不要调用 `events create` / `events update` / `events delete`；复盘永远不写时间线，唯一例外是前置的 `sources sync --all`。
- 不要主动发起复盘，也不要在会话结束时提议「要不要复盘一下今天」。
- 不要在用户没说存档时写文件，更不要默认写进仓库。
- 不要替用户补录缺口：发现空档只在「观察 / 明天」提一句分流，不启动 yesterday-recall 的流程。
- 不要为了格式虚构数字、时段或项目归属；数据撑不住的结论不写。
- 不要自动扩展日期，也不要顺手把周末、假期折进来——用户点名哪天就只复盘哪天。
