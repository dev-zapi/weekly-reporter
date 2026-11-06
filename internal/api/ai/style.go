package ai

import (
	"context"
	"database/sql"
	"errors"
	"math"

	"github.com/dev-zapi/weekly-reporter/internal/api/aiseed"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// styleConfig 是 src/lib/ai/styles.ts 的 AIStyleConfig 在 one-shot 路径上用到的
// 三个字段：systemPrompt / temperature 进提示词与请求参数，label 进响应体。
type styleConfig struct {
	Label        string
	SystemPrompt string
	Temperature  float64
}

// getAIStyle 复刻 getAIStyle(styleKey?)：先 ensureSeed()，再按 key 查，查不到
// 回退到 is_default 的行，最后回退到硬编码的「正式汇报」。
func (d *Deps) getAIStyle(ctx context.Context, styleKey string) (styleConfig, error) {
	d.ensureSeededStyles(ctx)

	if styleKey != "" {
		row, err := d.Queries.GetAIStyleByKeyForAI(ctx, styleKey)
		if err == nil {
			return rowToStyleConfig(row), nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return styleConfig{}, err
		}
	}

	row, err := d.Queries.GetDefaultAIStyleForAI(ctx)
	if err == nil {
		return rowToStyleConfig(row), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return styleConfig{}, err
	}

	return defaultStyleConfig(), nil
}

// getStyleFromTemplate 复刻 src/lib/ai/style-helpers.ts 的 getStyleFromTemplate：
// 模板不存在时回退到默认风格，存在则按模板的 ai_style 取风格。
func (d *Deps) getStyleFromTemplate(ctx context.Context, templateID int64) (styleConfig, error) {
	styleKey, err := d.Queries.GetTemplateAIStyleForAI(ctx, templateID)
	if errors.Is(err, sql.ErrNoRows) {
		return d.getAIStyle(ctx, "")
	}
	if err != nil {
		return styleConfig{}, err
	}
	return d.getAIStyle(ctx, styleKey)
}

func rowToStyleConfig(row db.AiStyle) styleConfig {
	temperature := math.NaN()
	if parsed, ok := jsnum.ParseFloat(row.Temperature); ok {
		temperature = parsed
	}
	return styleConfig{
		Label:        row.Label,
		SystemPrompt: row.SystemPrompt,
		// temperature 是 TEXT 列，TS 用 Number.parseFloat 解释。
		Temperature: temperature,
	}
}

// defaultStyleConfig 是 styles.ts 里「数据库里什么也没有」时的硬编码兜底：
// 内容与内置 formal 风格一致，直接引用 aiseed 的单一副本，避免第二处漂移。
func defaultStyleConfig() styleConfig {
	style := aiseed.Default()
	temperature, _ := jsnum.ParseFloat(style.Temperature)
	return styleConfig{
		Label:        style.Label,
		SystemPrompt: style.SystemPrompt,
		Temperature:  temperature,
	}
}

// resolveStyle 复刻三条 route.ts 各自的风格选择优先级。
//
// 三处顺序互不相同，所以由调用方传进 overrideFirst 而不是统一成一种：
//   - expand-section / unify-style：templateId → styleOverride → 默认
//   - polish-event：                styleOverride → templateId → 默认
func (d *Deps) resolveStyle(ctx context.Context, raw map[string]any, overrideFirst bool) (styleConfig, error) {
	template := func() (styleConfig, error) {
		value := raw["templateId"]
		if templateID, ok := asID(value); ok {
			return d.getStyleFromTemplate(ctx, templateID)
		}
		// 数值/字符串绑得进去但没命中（1.5、"1abc"），getStyleFromTemplate 在
		// 查询到零行时会回退到默认风格；绑不进去的形态（布尔/数组/对象）让
		// better-sqlite3 抛错，最终是 route.ts 的 500 分支。
		if unbindableJSON(value) {
			return styleConfig{}, errUnbindableValue
		}
		return d.getAIStyle(ctx, "")
	}
	override := func() (styleConfig, error) {
		value := raw["styleOverride"]
		// 布尔/数组/对象让 better-sqlite3 绑定抛错（route.ts 的 500 分支）。
		if unbindableJSON(value) {
			return styleConfig{}, errUnbindableValue
		}
		// 非字符串（数字/null）绑得进去但不会命中任何真实风格 key
		// （key 是 TEXT 列，驱动把 JS 数字绑成 REAL），等价于回退默认风格。
		key, isString := value.(string)
		if !isString {
			return d.getAIStyle(ctx, "")
		}
		return d.getAIStyle(ctx, key)
	}

	hasTemplate := truthyJSON(raw["templateId"])
	hasOverride := truthyJSON(raw["styleOverride"])

	if overrideFirst {
		if hasOverride {
			return override()
		}
		if hasTemplate {
			return template()
		}
		return d.getAIStyle(ctx, "")
	}

	if hasTemplate {
		return template()
	}
	if hasOverride {
		return override()
	}
	return d.getAIStyle(ctx, "")
}

// errUnbindableValue 对应 route.ts 把布尔/数组/对象交给 drizzle 绑定时驱动抛出
// 的异常：三条路由都落进 500 分支。文案只进 details 诊断字段。
var errUnbindableValue = errors.New("SQLite3 can only bind numbers, strings, bigints, buffers, and null")
