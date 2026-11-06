package ai

import (
	"context"
	"log"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/aiseed"
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
//
// 四条内置风格的数据在 internal/api/aiseed（与提示词管理域共用唯一副本），本文件
// 只保留本域的插入策略。
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
	for _, style := range aiseed.Styles {
		isDefault := int64(0)
		if style.IsDefault {
			isDefault = 1
		}
		err := d.Queries.InsertAIStyleForAI(ctx, db.InsertAIStyleForAIParams{
			Key:          style.Key,
			Label:        style.Label,
			SystemPrompt: style.SystemPrompt,
			Temperature:  style.Temperature,
			IsDefault:    isDefault,
			CreatedAt:    now,
			UpdatedAt:    now,
		})
		if err != nil {
			log.Printf("seed ai_styles %s: %v", style.Key, err)
		}
	}
}
