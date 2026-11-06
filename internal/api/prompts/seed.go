package prompts

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/aiseed"
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
	// 四条内置风格的数据（含完整 systemPrompt）只有一份：internal/api/aiseed，
	// 本域与 /api/ai/* 的 one-shot 域共用，插入策略各自保留。
	if count, err := queries.CountAIStylesForPromptRoutes(ctx); err != nil {
		log.Printf("[seed] Failed to seed ai_styles: %v", err)
	} else if count == 0 {
		for _, style := range aiseed.Styles {
			isDefault := int64(0)
			if style.IsDefault {
				isDefault = 1
			}
			if _, err := queries.InsertAIStyleForPromptRoutes(ctx, db.InsertAIStyleForPromptRoutesParams{
				Key:            style.Key,
				Label:          style.Label,
				SystemPrompt:   style.SystemPrompt,
				Temperature:    style.Temperature,
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
