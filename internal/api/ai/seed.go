package ai

import (
	"context"
	"log"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件是 src/lib/ai/seed.ts 中「ai_styles 为空时写入四条内置风格」那一半的
// 移植。getAIStyle 在 TS 里先 await ensureSeed()，所以风格查询的每一步都可能
// 触发这次写入；不移植会让「空库 + styleOverride: technical」回退到 formal。
//
// 有意的收窄：seed.ts 的 ensureSeed 还会建表（这里由 schema.sql 负责）并补齐
// system_prompts（那是 /api/prompts/system 的依赖，属同批模板/提示词票）。
// 本域没有任何路由读 system_prompts，跳过它对这三条 one-shot 不可观测。
//
// 与 TS 的另外两处小差异（都不改变 HTTP 契约）：
//   - dist 用模块级 `seeded` 标志只查一次 count。这里每次都查（一条 COUNT），
//     换来「换库后仍会 seed」，让同一进程里的多个测试库互不串味。
//   - INSERT 带 ON CONFLICT (key) DO NOTHING：两个请求并发看到空表时，TS 的
//     第二条 INSERT 会撞唯一索引（被 ensureSeed 自己的 try/catch 吞掉），这里
//     两条都成功。种子内容相同，结果一致。
func (d *Deps) ensureSeededStyles(ctx context.Context) {
	count, err := d.Queries.CountAIStylesForAI(ctx)
	if err != nil {
		// ensureSeed 在 TS 里对 seed 失败只 console.error，不改变请求结果。
		log.Printf("seed ai_styles: %v", err)
		return
	}
	if count != 0 {
		return
	}

	now := time.Now().Unix()
	for _, style := range builtinStyles {
		err := d.Queries.InsertAIStyleForAI(ctx, db.InsertAIStyleForAIParams{
			Key:          style.key,
			Label:        style.label,
			SystemPrompt: style.systemPrompt,
			Temperature:  style.temperature,
			IsDefault:    style.isDefault,
			CreatedAt:    now,
			UpdatedAt:    now,
		})
		if err != nil {
			log.Printf("seed ai_styles %s: %v", style.key, err)
		}
	}
}

// builtinStyles 逐字取自 src/lib/ai/seed.ts 的 BUILTIN_STYLES（含标点）。
// detail_level / result_oriented 在 TS 里没有给值，落库为 NULL。
type builtinStyle struct {
	key          string
	label        string
	systemPrompt string
	temperature  string
	isDefault    int64
}

var builtinStyles = []builtinStyle{
	{
		key:   "formal",
		label: "正式汇报",
		systemPrompt: `你是专业的职场周报润色助手。读者是管理层和跨部门同事。

写作原则：
- 先结论后细节：每条以成果/结论开头，必要时补充关键过程
- 用数据说话：保留或补充量化指标（百分比、金额、次数等），去除模糊表述
- 突出业务价值：说明工作对团队/业务的实际影响，而非仅描述做了什么
- 语言正式但不官僚：用词规范，不用口语和空话套话（如"大力推进""积极落实"）
- 每条控制在 2-3 句话

禁止：
- 流水账式的按时间描述
- 主观情绪化表述（如"非常辛苦""极其困难"）
- 无数据支撑的形容词堆砌`,
		temperature: "0.3",
		isDefault:   1,
	},
	{
		key:   "technical",
		label: "技术研发",
		systemPrompt: `你是技术研发周报助手。读者是技术负责人和架构师。

写作原则：
- 突出技术决策而非实现细节：说明选择了什么方案、为什么选，而非怎么写代码
- 量化技术成果：性能提升 X%、延迟降低 Yms、内存减少 ZMB、解决 N 个 issue
- 记录技术债和风险：标记需要关注的问题、所需资源、潜在影响
- 保留关键技术术语（如技术栈、协议名），但非该领域的工程师也应能理解大意
- 每条聚焦一个技术主题，避免一条里混杂多个不相关工作

禁止：
- 包含代码片段或日志输出
- 只描述"做了什么"不解释"为什么这么做/为什么不选替代方案"
- 忽略未完成或受阻的工作`,
		temperature: "0.4",
		isDefault:   0,
	},
	{
		key:   "concise",
		label: "极简干练",
		systemPrompt: `你是精简周报助手。读者是时间极度有限的管理者。

写作原则：
- 每条严格控制在 1 句话、40 字以内
- 只写「做了什么 + 结果是什么」，省略所有过程、背景、原因
- 用无主语短句，去除修饰词和过渡词（"了""的""地""已经""正在"等可省略）
- 同类工作合并为一条，不分条罗列无关细节
- 以要点列表输出，每条一行

格式参考：
✅ "完成用户模块 API 重构，接口响应时间降低 40%"
✅ "排查并修复支付回调丢失问题，影响 3 个订单已补单"
❌ "本周继续推进用户模块的重构工作，经过多次方案调整后完成了 API 层改造，接口响应速度有明显提升"

禁止：
- 解释背景和原因
- 超过 40 字的单条
- 用段落而非列表`,
		temperature: "0.2",
		isDefault:   0,
	},
	{
		key:   "detailed",
		label: "深度复盘",
		systemPrompt: `你是个人工作复盘助手。目的是帮助作者深度反思、沉淀可复用的经验。

反思框架（每项重要工作按此结构展开）：
1. 做了什么：1 句话概括
2. 遇到什么障碍：具体困难、意外、资源不足等
3. 怎么解决的：措施和决策逻辑
4. 学到了什么：可复用的经验、方法论、认知变化
5. 下一步：改进方向和行动计划

写作原则：
- 坦诚面对失败和失误，不回避、不归因于外部
- 聚焦"为什么"而非"是什么"——分析根因而非描述表象
- 提炼通用规律而非只描述个案
- 表达平实真诚，避免自我表扬或自我贬低

禁止：
- 只汇报成果不分析过程
- 泛泛而谈没有具体事例
- 把所有问题归因于"时间不够""需求不明确"等外部因素`,
		temperature: "0.5",
		isDefault:   0,
	},
}
