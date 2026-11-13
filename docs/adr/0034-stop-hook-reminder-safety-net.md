---
status: accepted
---

# Stop-hook 提醒器：harness 强制的 summarize-event 会话收尾安全网 (2026-11-12)

summarize-event 契约里最弱的两条规则全部依赖模型自觉：「约 3 个成果堆积时 offer」——模型对堆积数量没有可靠感知；「session 结束前有未记录工作总要 offer」——模型根本感知不到 session 何时结束，这条实际上从未被可靠执行过。可行性调研（`~/hermes-docs/summarize-event-hook-feasibility-20261112.md`，官方 hooks reference 2026-11-10 版与本机 v2.1.311 二进制交叉验证）确认 hook 机制可把这两条从"模型记忆"变为"harness 强制"。本 ADR 固定落地形态。

**决策要点：**

1. **Stop-hook 提醒器**（`skills/summarize-event/hooks/stop-reminder.sh`，command handler）：主 agent 每次安静结束响应时本地判断「是否有未记录工作」，命中则输出 `hookSpecificOutput.additionalContext`（transcript 显示为 Stop hook feedback，无红色错误）驱动模型按 skill 四选项规则 offer。语义是提醒不是阻断，故不用 `decision: block`。
2. **触发条件**（纯本地，<50ms 目标）：全局最新时间线事件（`node <部署路径>/weekly-reporter/scripts/wrp.mjs events list --limit 1`，10min TTL 缓存，失败即放行）之后当前 repo 有新 commit（`git -C $cwd log --since`，一律用 hook 输入的 `cwd` 而非 `$CLAUDE_PROJECT_DIR`，worktree 下两者不同）；或距 `max(会话首见, 最近事件, 最近重置)` ≥ 120min 的**时长兜底**——捕捉没有 commit 痕迹的测试、调试、评审类工作，代价是纯聊天长会话也可能收到一次 offer（答一次 skip 即静默）。阈值为脚本内常量。
3. **反骚扰**：递进冷却 30→60→120min 封顶；skip 本会话静默；`stop_hook_active` 直接放行（另有 harness 8 次连续上限兜底）；**未答复上限**——每次提醒自记 `unanswered+1`，任何 remind-state 答复清零，累计 ≥3 次未答复即视同 skip 静默（不自动替用户回答，未记录工作留在未记录）；**hook 发出提醒时自记 offer 时间 + 默认 20min 冷却**，不等 remind-state——否则用户不答复 offer 时状态永远不落，下个 Stop 每回合重复提醒（冷却只升不降，`now` 是唯一重置点）。四选项落地：now 全重置（含直接发送 / summarize-event-quick 跑完）；notyet 递进冷却；skip 静默；end 记时 + 120min（阶梯顶，逼近"会话将尽再提醒"的语义）。
4. **fail-open**：守卫链任何一环异常（jq 缺失、状态文件损坏、wrp 401/网络失败、非 git 目录）一律静默放行，提醒器永不阻塞正常收尾。
5. **状态**：按 session_id 分文件（`~/.cache/wrp-remind/<sid>.json`），多会话并行天然隔离；sid 由 hook 内嵌进提醒文本传给模型（模型在会话内不知道自己的 sid；transcript 最新文件启发式仅作自主 offer 时的兜底）；SessionEnd hook 清理本会话状态，stop-reminder 顺手清理 >7 天残文件。
6. **分发**：用户级 `~/.claude/settings.json` 接线，指向**部署副本路径**（拷贝安装制，延续 ADR 0031 与本机 impeccable 先例），守卫式 `[ ! -f … ] || …` 写法（脚本缺失静默跳过）；拷贝与接线均手工执行，接线片段抄录自 `skills/summarize-event/hooks/README.md`。

## Considered Options

- **SessionEnd 里 `claude -p` 自动总结并写入**：默认 1.5s 总预算、无交互、无预览，且违背 preview-first 契约——否决。
- **hook 直接替用户 `wrp events create`**：破坏「用户确认后创建」的核心契约——否决。
- **`decision: block` 强续**：语义是拒绝停下（transcript 红色错误），提醒场景过重——否决。
- **prompt-type Stop handler**（后台模型判断 ok/false）：每回合多一次模型调用，本地条件判断已足够——否决。
- **PostToolUse 检测 commit 即 nudge**：accomplishment ≠ commit 且每步注入太吵——降级为 v2 计数器候选。
- **UserPromptSubmit 注入 additionalContext**：每条 prompt 前都跑，污染面大于回合边界的 Stop 时点——否决。
- **per-repo 触发基线**（状态记上次 offer 时的 HEAD）：精确但状态更重，且 HEAD 前进 ≠ 新工作（rebase 误动）；v1 接受全局基线的跨项目盲区（A 仓未记录 commit 在任何更晚事件出现后不再提醒），靠注册采集源 sync（commit 落成 auto 事件）与 daily-review / yesterday-recall 兜底。
- **skill frontmatter 自动挂载、idle_prompt 铃声、commit 计数器、PreCompact 检查点**：留 v2，本期不做。

## Consequences

- 一处手工 settings 接线不可避免：hook 分发面只有 settings/policy/插件/skill-frontmatter 四条通道，没有「随目录自动生效」。
- 跨项目盲区与时长兜底误报在决策时已明确接受；空时间线（`{"events":[]}`）视最近事件为 epoch 0，任何 commit 都算未记录（安全网方向）。
- SKILL.md 契约新增 remind-state 落地义务：四个答复都要落状态（含 end——否则 hook 不知道刚 offer 过会立即重复提醒）；offer 话术与 hook 提醒文案（英文）同构，harness 提醒与模型自觉两条路径收敛到同一四选项交互。
- 状态文件格式、冷却阶梯与 120min 阈值成为跨机器长期存在的契约，调整需同步 README 的接线片段与测试 fixtures。
- 守卫链与触发条件由 `hooks/test-stop-reminder.sh`（fixtures 驱动）守护；上线后观察 1 天骚扰率与延迟，再决定 v2 项取舍。
