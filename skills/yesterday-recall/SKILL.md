---
name: yesterday-recall
description: Reconstruct one day's work (昨日回忆) across all projects and fill the timeline gaps the morning after. Use this skill only when the user explicitly asks to recall a day — never offer it proactively. Triggers on phrases like "回忆一下昨天", "昨日回忆", "回忆 11 月 3 号", "回忆一下昨天的进展", "帮我回顾一下昨天", "recall yesterday", "yesterday recap", "what did I do yesterday". The default day is the literal calendar yesterday; a user-named date is used verbatim. For logging one just-finished task use summarize-event; for browsing an arbitrary date range use weekly-reporter (wrp events).
---

昨日回忆是「第二天早上补昨天时间线」的固定仪式：把一天里散落在时间线、`.remember` 记忆文件和当周计划中的工作痕迹收拢，让用户补记漏掉的部分，蒸馏成一行式手动事件，经确认页逐条裁决后落库，最后在聊天里给出完整的一天全貌。

## 边界与触发

- **仅显式触发。** 只有用户明确要求回忆某一天时才运行；不要主动 offer，不要在会话结束时自动提议，也不要因为看到时间线有空档就自行启动。用户没说要回忆，就什么都不做。
- **日期语义。** 默认是字面意义上的「昨天」（运行当天的前一个日历日）。用户指定日期（如「回忆 11 月 3 号」）就回忆那一天。**不做**周一补周末、节后补假期之类的自动扩展——要补哪一天就只处理哪一天，需要更多天就由用户逐天再触发。
- **范围。** 回忆日的所有项目，不按工作/个人或单个仓库切分。
- **不适用。** 记录刚完成的一段工作 → **summarize-event**；浏览任意日期区间，或查询、编辑单条时间线事件 → **weekly-reporter（wrp events）**；写周报 → **writing-weekly-report**（weekly-reports 技能已并入 wrp，只浏览周报用 `wrp reports`）。

## 前置

- 本技能自带一次性交互页脚本 `{baseDir}/scripts/board.mjs`（`{baseDir}` 是本技能目录）。它起一个只服务一页、只接受一次提交的临时 HTTP 服务，写答案文件后退出；端口从 19950 起向上找，绑定 `0.0.0.0` 且无鉴权——**仅限可信局域网，输入 JSON 里绝不能放密钥**。首次提交成功，重复提交返回 409。
- 数据读写通过统一客户端 **weekly-reporter（wrp）**：入口 `node <weekly-reporter>/scripts/wrp.mjs <module> <verb> [args]`（`<weekly-reporter>` 指代 weekly-reporter 技能目录）。本技能用到 `wrp events`（列表、创建）、`wrp sources`（枚举、查看）与 `wrp plans`（列表）；每级都可用 `--help` 查看。若该技能未安装为技能，直接从 weekly-reporter 仓库的 `skills/weekly-reporter/` 目录运行 `scripts/wrp.mjs`。
- wrp 用内置 `fetch`（Node 18+），从环境变量（`WEEKLY_REPORTER_PAT`；`WEEKLY_REPORTER_BASE_URL` 或别名 `WEEKLY_REPORTER_URL`）或 `~/.config/weekly-reporter/auth.json` 读取凭据，base URL 默认 `http://localhost:6868`。任何 `/api/**` 调用返回 401 时，让用户在会话里运行 `! node <weekly-reporter>/scripts/wrp.mjs init` 配置 PAT，再重试（`init` 也支持 `--pat` / `--show` / `--clear`）。

## 工作流

### 阶段 1 — 锚点收集

先定日期 `D`（`YYYY-MM-DD`），再收集这一天已有的全部痕迹。**锚点收集必须发生在起任何交互页之前**——页面上要让用户看着已有锚点补空档。

1. **时间线事件。** 分别取自动与手动两个来源，覆盖全量（单日事件可能很多，用脚本允许的最大 `--limit 200`）：

   ```bash
   node <weekly-reporter>/scripts/wrp.mjs events list --date <D> --source auto --limit 200
   node <weekly-reporter>/scripts/wrp.mjs events list --date <D> --source manual --limit 200
   ```

   输出每行以 `#<id>` 开头，含时间、来源、内容。若尾部出现 `next page: --cursor …` 分页提示，说明当天超过 200 条——按现有输出继续（锚点是提示，不必是完整日志），并在给用户的说明里提一句当天事件特别密集。

2. **`.remember` 记忆文件。** 回忆日的记忆文件可能是 `today-<D>.md`（当天还在进行）或 `today-<D>.done.md`（已归档）。读取两处：

   - **本仓库主 checkout**：先推导主 checkout 路径，再读其中的 `.remember/today-<D>.md` 或 `today-<D>.done.md`。在任意 worktree 下执行：

     ```bash
     main_checkout="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
     ```

     主 checkout 的 `.git` 是所有 worktree 共享的 common dir，它的父目录就是主 checkout（而不是当前 worktree）。若该命令失败（不在 git 仓库或 git 不可用），降级为当前工作目录，并在给用户的说明里提示无法定位主 checkout、`.remember` 可能不完整。
   - **每个 git-local 采集源的主 checkout**：先枚举源，再逐个取本地路径。

     ```bash
     node <weekly-reporter>/scripts/wrp.mjs sources list --type git-local
     node <weekly-reporter>/scripts/wrp.mjs sources show <ref>
     ```

     `wrp sources show <ref>` 输出中 `config:` 标头下缩进的那行 `owner:` 就是该 git-local 源的绝对本地路径；据此检查 `<owner>/.remember/today-<D>.md` 与 `today-<D>.done.md`。`unavailable` 的源、路径不存在的源、没有该文件的源都**优雅跳过**，不要报错、不要中断流程，也不要因此去修采集源。

   记忆文件是自由格式，常见形态是 `HH:MM | 分支` 后跟一段叙述，或 `HH:MM-HH:MM | ...` 的单行记录，也有 `## HH:MM-...` 小标题。取行内第一个 `HH:MM` 作为锚点时间，其余作为文本；无法解析时间的记录归为「其他」锚点组，供蒸馏时参考。

3. **当周周期计划。** 取回忆日所在周的计划，以及重叠的月度计划（`%id` 关联用）：

   ```bash
   node <weekly-reporter>/scripts/wrp.mjs plans list --scope week --date <D>
   node <weekly-reporter>/scripts/wrp.mjs plans list --scope month --date <D>
   ```

   保留 `planned` / `in_progress` 的开放条目用于阶段 3 的自动关联；`done` 已完成、`cancelled` 不关联；`deferred` 的活条目是它下一周期的后继，用后继而不是原条目。

4. **归一化为锚点。** 自动时间线事件 → `{ time: "HH:MM", src: "git", text: 内容 }`（页面标签「提交」）；手动时间线事件 → `{ time: "HH:MM", src: "manual", text: 内容 }`（页面标签「手动」）；`.remember` 记录 → `{ time: "HH:MM", src: "mem", text: 文本 }`（标签「记忆」）。所有时间线事件（自动 + 手动）同时保留为确认页的「已有事件」（只读）。无法解析时间的记录归为「其他」锚点组，供蒸馏时参考。

### 阶段 2 — 空档收集

把锚点整理成 `--gaps` 输入 JSON（写到 `/tmp` 等临时位置，不写进仓库）：

```json
{
  "date": "2026-11-06",
  "anchors": [
    { "time": "10:30", "src": "git", "text": "test(collect): pin JS number and branch ordering semantics" },
    { "time": "02:37", "src": "mem", "text": "weekly-reporter migration B1 收尾并合并" }
  ]
}
```

后台启动收集页并等待用户提交（进程会阻塞到收到唯一一次提交后退出）：

```bash
node {baseDir}/scripts/board.mjs --gaps /tmp/yesterday-recall-gaps-<D>.json --answers /tmp/yesterday-recall-gaps-<D>.answers.json
```

从 stdout 解析 `ANSWERS_FILE <路径>` 和若干 `LISTENING http://<ip>:<port>/` 行。把**非 `127.0.0.1`** 的局域网地址给用户（没有局域网地址时退回 `127.0.0.1`），说明这是一次性页面：按上午/下午/晚上分段补空档，可以留空，提交后即关闭。等待进程退出，读取答案文件。

答案契约：

```json
{ "date": "2026-11-06", "blocks": { "morning": "…", "afternoon": "…", "evening": "…", "other": "…" } }
```

- 只包含用户实际填写的块（服务端丢弃空块），键只可能是 `morning` / `afternoon` / `evening` / `other` / `wholeday`。
- **当天没有任何锚点时**，页面渲染成单个全天开放式问题，答案只有 `wholeday` 一个键。不要给空态强行造上午/下午/晚上。
- `blocks` 里的文本可能带换行，蒸馏时自行折叠，不必在这里处理。

### 阶段 3 — 蒸馏

把 `.remember` 原文、`blocks` 补记、时间线锚点、计划条目合在一起，蒸馏成**一行式手动事件草稿**。标准与 **summarize-event** 一致：

- **一条可命名成果一条草稿。** 能一句话命名「做成了什么」才成条；不要把一天写成流水账。
- **保留 shipped / fixed / decided 与结果**，丢掉来回沟通、反复改稿、死路、旁枝等过程细节；相关的小事合并成一条成果，而不是逐条罗列。
- **点名项目/仓库**，时间线跨多个项目，不点名读者无法判断归属。
- **单行纯文本。** 草稿内容不能含换行；提交前把换行替换成空格。

时间归属：上午的补记给一个上午时间，下午给下午时间，晚上给晚上时间；用户明确说了几点就用几点。`wholeday` 的全天回忆按内容大致分布到一天里，给一个可编辑的建议时间即可——确认页允许逐条改时间。

**`%id` 自动关联。** 对每条草稿，若与当周/当月计划里某个开放条目明显对得上（同项目/仓库 + 同功能、修复或主题），直接把空格边界完整的 `%<id>` 嵌进该条草稿。判断清楚的自动带，**不要逐条问用户**；判断不清就不带，或留到确认页让用户裁决。周条目与它的月父条目都匹配时用周条目。`done` / `cancelled` 不关联；`deferred` 用其后继。

**`#tag` 建议。** 在行尾用空格分隔给出建议标签；优先复用时间线上已有的标签，而不是新造。标签只有在行首或空白之后、且以空白或行尾结束才生效——`。#tag`、`（#tag）` 会静默失效。标签字符集只含汉字、字母、数字（至少一个字母）；连字符和下划线会截断标签，`#my-tag`、`#my_tag` 都不会被解析（详见 weekly-reporter 的标签规则，`references/events.md`）。

**去重。** 若一条草稿已被某条自动事件覆盖，就跳过它，或用时间线查询输出里真实出现过的 `@<id>` 引用它，而不是再描述一遍；不要制造重复记录。`@id` 同样受空白边界约束，且只能引用查询输出里出现过的 id。

草稿整理成 `--confirm` 输入 JSON：

```json
{
  "date": "2026-11-06",
  "existing": [ { "time": "10:30", "src": "auto", "text": "…" } ],
  "drafts":   [ { "time": "09:30", "text": "把迁移蓝图拆成 22 张工单 %12 #迁移" } ]
}
```

`existing` 放回忆日的全部时间线事件（自动 + 手动），页面只读展示；`drafts` 只放本次新蒸馏出的条目。

### 阶段 4 — 确认

后台启动确认页并等待提交：

```bash
node {baseDir}/scripts/board.mjs --confirm /tmp/yesterday-recall-confirm-<D>.json --answers /tmp/yesterday-recall-confirm-<D>.answers.json
```

同样把局域网地址给用户。页面左栏是只读的已有事件，右栏是草稿卡片：每张有纳入勾选框、行内可改的时间、可多行编辑的内容框。告诉用户可以逐条改、逐条排除，也可以全部排除——**全部排除就是零落库**。等待进程退出，读取答案文件。

答案契约：

```json
{ "date": "2026-11-06", "confirmed": [ { "content": "… %12 @8891 #迁移", "time": "13:50" } ] }
```

- 被排除的草稿**直接不出现**在 `confirmed` 里；全部排除时是空数组。
- 服务端已把 `content` 里的所有空白（含换行）折叠成单空格并 trim，把 `time` 规范成 `HH:MM`。提交的 `time` 为空或非法时，服务端回退该草稿输入里的原始默认时间；仍不可用则丢弃该条。落库时**原样使用答案文件**，不要用自己的版本覆盖。
- 若 `confirmed` 为空：跳过阶段 5 的创建，明确告诉用户「本次零落库」，仍然输出最后的全貌。

### 阶段 5 — 落库与收尾

对 `confirmed` 里的每一条，经 **weekly-reporter（wrp）** 的 `wrp events create` 创建手动事件，并用 `--time` 把时间回填到回忆日。`--time` 必须是带显式偏移的绝对时刻：偏移从运行系统的时区取（`date +%:z` 可得到当前偏移，如 `+08:00`），让「那天的那个时刻」落在用户日历上；缺偏移的 naive 时间会被客户端直接拒绝：

```bash
node <weekly-reporter>/scripts/wrp.mjs events create "<content>" --time "<D>T<HH:MM>:00$(date +%:z)"
```

例如回忆 2026-11-06 的 09:30 写成 `--time "2026-11-06T09:30:00+08:00"`。

- 一条草稿一次 `events create`，确认几条就创建几条，不多不少；记录每条返回的 `✓ event created: #<ID>`。
- 内容用 `confirmed[i].content`，时间用 `confirmed[i].time`。
- 确认页的提交即 `events create` 所要求的 preview 确认：用户在确认页逐条裁决后，无需再问一遍。
- 回填失败（例如 401）按 wrp 的错误处理（`✗ … → <fix>`）排查，不要把失败当成已落库。

最后在聊天里输出**「昨日全貌」合并视图**：已有的自动/手动事件 + 本次新落库的事件，按时间顺序合并，标注新增事件的 id。这个全貌**只在聊天里展示，绝不作为事件再落库**，也不写进时间线。

## 错误处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `unauthorized (HTTP 401)` | PAT 缺失、失效或撤销 | 让用户在会话里运行 `! node <weekly-reporter>/scripts/wrp.mjs init` 配置 PAT，再重试 |
| `Cannot reach weekly-reporter` | 服务未启动 | 提示用户启动（开发用 `make dev`，已安装服务用 `make start`）或检查 base URL |
| board 输出 `submission already received` / 409 | 该页面已提交过 | 一次性页面正常收敛；读取已写出的答案文件即可 |
| 端口 19950 被占用 | 其它一次性页面在跑 | 脚本自动向上找端口，用 stdout 里的实际地址 |
| 时间线某天为空但明显在写代码 | 采集源没同步 | 提示用户可用 **collect-git-source** 同步；不要阻塞回忆，`.remember` 仍可提供锚点 |

## 不要做的事

- 不要因为「昨天」是周一就自动补周末，也不要因为今天是节后第一天就自动扩展日期。
- 不要主动发起本技能，或把「要不要回忆一下」当成例行提醒。
- 不要把确认页上被排除的草稿偷偷落库，也不要凭自己的判断补回用户明确排除的条目。
- 不要把「昨日全貌」写进时间线。
- 不要在 `board.mjs` 的输入里放 PAT、token 或任何密钥；页面在局域网上无鉴权可读。
