package prompts

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件移植 src/lib/ai/seed.ts：首次访问 prompts 路由时确保内置 AI 风格与
// 系统提示词存在。
//
// 与 TS 的差别只有一处（均为不可观测）：TS 的 ensureTables 会用原始连接执行
// `CREATE TABLE IF NOT EXISTS`，绕过 drizzle 迁移链；Go 侧的表由冻结的
// schema.sql / 迁移账本保证（ADR-0026，serve 启动即 fail-closed 校验），
// 因此这里不再重复 DDL，否则等于让应用层二次拥有 schema。
//
// `seeded` 缓存：TS 是模块级变量，首次调用后整个进程不再重跑。Go 把这份状态
// 放在 Mount 时创建的 Seeder 里——一个 router 实例对应一个进程，语义等价，
// 同时让每个 httptest harness（独立 DB）各自获得一次 seed。

// Seeder 是 ensureSeed 的进程级缓存。
type Seeder struct {
	mu     sync.Mutex
	seeded bool
}

// Ensure 复刻 ensureSeed()：幂等，只在首次调用时写入内置数据。
func (s *Seeder) Ensure(ctx context.Context, queries *db.Queries) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seeded {
		return
	}

	now := time.Now().Unix()

	// Seed AI styles if empty（styles 的 count 查询失败只记录，不阻断请求）。
	if count, err := queries.CountAIStylesForPromptRoutes(ctx); err != nil {
		log.Printf("[seed] Failed to seed ai_styles: %v", err)
	} else if count == 0 {
		for _, style := range builtinStyles {
			isDefault := int64(0)
			if style.isDefault {
				isDefault = 1
			}
			if _, err := queries.InsertAIStyleForPromptRoutes(ctx, db.InsertAIStyleForPromptRoutesParams{
				Key:            style.key,
				Label:          style.label,
				SystemPrompt:   style.systemPrompt,
				Temperature:    style.temperature,
				DetailLevel:    nil,
				ResultOriented: nil,
				IsDefault:      isDefault,
				CreatedAt:      now,
				UpdatedAt:      now,
			}); err != nil {
				log.Printf("[seed] Failed to seed ai_styles: %v", err)
				break
			}
		}
	}

	// Seed system prompts if missing（逐个 key 判断，缺哪个补哪个）。
	for _, prompt := range builtinSystemPrompts {
		_, err := queries.GetSystemPromptForPromptRoutes(ctx, prompt.key)
		if errors.Is(err, sql.ErrNoRows) {
			if _, err := queries.InsertSystemPromptForPromptRoutes(ctx, db.InsertSystemPromptForPromptRoutesParams{
				Key:        prompt.key,
				Label:      prompt.label,
				PromptText: prompt.promptText,
				CreatedAt:  now,
				UpdatedAt:  now,
			}); err != nil {
				log.Printf("[seed] Failed to seed system_prompts: %v", err)
				break
			}
			continue
		}
		if err != nil {
			log.Printf("[seed] Failed to seed system_prompts: %v", err)
			break
		}
	}

	s.seeded = true
}

// builtinStyle 是 BUILTIN_STYLES 的元素：temperature 在 TS 里就是字符串。
type builtinStyle struct {
	key          string
	label        string
	systemPrompt string
	temperature  string
	isDefault    bool
}

// builtinStyles 逐字移植 src/lib/ai/seed.ts 的 BUILTIN_STYLES（顺序也是契约：
// 首次列表中 formal 在最前，且是默认风格）。
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
		isDefault:   true,
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
	},
}

// builtinSystemPrompt 是 BUILTIN_SYSTEM_PROMPTS 的元素。
type builtinSystemPrompt struct {
	key        string
	label      string
	promptText string
}

// builtinSystemPrompts 逐字移植 src/lib/ai/seed.ts 的 BUILTIN_SYSTEM_PROMPTS。
var builtinSystemPrompts = []builtinSystemPrompt{
	{
		key:   "check",
		label: "写作建议",
		promptText: `你是一个周报写作助手。用户正在写周报，请分析以下内容并给出改进建议。

内容：
{{content}}

{{#section}}当前区块：{{section}}{{/section}}

请从以下方面分析：
1. 是否有具体数据和细节支撑
2. 是否突出了成果和价值
3. 表达是否清晰简洁
4. 是否有更好的表达方式

请给出具体、简洁的建议（每条不超过20字）。
如果内容很好，返回空数组 []。`,
	},
	{
		key:   "generate",
		label: "终版生成",
		promptText: `你是周报终版生成助手。请严格依据原稿中的事实，按照模板要求输出 Markdown 周报。

规则：
- 只处理当前受众版本提供的原稿，不得引入其他版本的信息。
- 可以重组、合并、概括和补全表达，但不得虚构项目、数字、结果、时间或计划。
- 模板是格式规范，不要输出模板占位符、解释文字或代码围栏。
- 原稿没有事实支撑的章节请省略，或明确写出暂无内容。
- 只返回终版 Markdown 正文。`,
	},
}
