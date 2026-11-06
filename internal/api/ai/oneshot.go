package ai

import (
	"context"
	"database/sql"
	"errors"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
)

// AIConfigError 是 provider.ts 里 `AI_API_KEY 未配置` 那个错误类的对应物：
// route.ts 对它回 400 + AI_NOT_CONFIGURED，其余错误一律 500。
type AIConfigError struct{ Message string }

func (e *AIConfigError) Error() string { return e.Message }

// newClient 复刻 src/lib/ai.ts 的 getModel：读 ai_config 单行并建客户端，
// 没有配置行时抛 AIConfigError。
func (d *Deps) newClient(ctx context.Context) (*aiclient.Client, error) {
	row, err := d.Queries.GetAIConfigForAI(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &AIConfigError{Message: "AI_API_KEY 未配置"}
	}
	if err != nil {
		return nil, err
	}

	return aiclient.New(aiclient.Config{
		Protocol: row.Protocol,
		BaseURL:  row.ApiUrl,
		APIKey:   row.ApiKey,
		Model:    row.Model,
	}), nil
}

// polishEvent 复刻 src/lib/ai.ts 的 polishEvent。
func (d *Deps) polishEvent(ctx context.Context, content, systemPrompt string, temperature float64) (string, error) {
	object, err := d.generate(ctx, aiclient.ObjectRequest{
		Prompt:      systemPrompt + "\n\n请润色以下内容。保持原意不变，仅优化表达方式、补充数据感、调整句式。直接返回润色后文本，不要添加任何解释。\n内容中的 @数字（如 @7008）是对另一事件的引用，必须原样保留，不改写、不展开、不删除。\n\n" + content,
		Temperature: temperature,
		Schema:      jsonRaw(polishSchema),
	}, validatePolished)
	if err != nil {
		return "", err
	}
	return requireString(object, "polishedContent")
}

// expandedItem 是 expandSection 结果里的一项：
// `{ content: string; source: 'existing' | 'generated' }`。
//
// content 刻意是 any：route.ts 只校验 existingItems 是数组、不校验元素类型，
// 已有条目原样回显（数字就是 JSON 数字）。generated 一侧总是模型给的字符串。
type expandedItem struct {
	Content any    `json:"content"`
	Source  string `json:"source"`
}

// expandSection 复刻 src/lib/ai.ts 的 expandSection：已有条目按 existing 回放，
// 模型给的新条目按 generated 追加。
func (d *Deps) expandSection(
	ctx context.Context,
	sectionTitle string,
	existingItems, events []any,
	systemPrompt string,
	temperature float64,
) ([]expandedItem, error) {
	object, err := d.generate(ctx, aiclient.ObjectRequest{
		Prompt: systemPrompt + "\n\n章节标题：" + sectionTitle +
			"\n\n已有条目：\n" + jsJoin(existingItems, "\n") +
			"\n\n可用事件素材：\n" + jsJoin(events, "\n") +
			"\n\n请基于事件素材生成新的条目来补充这个章节。每条与已有条目不重复，格式与已有条目保持一致。仅输出新条目内容，不要扩写或修改已有条目。",
		Temperature: temperature,
		Schema:      jsonRaw(expandSchema),
	}, validateNewItems)
	if err != nil {
		return nil, err
	}

	newItems, err := requireStringArray(object, "newItems")
	if err != nil {
		return nil, err
	}

	results := make([]expandedItem, 0, len(existingItems)+len(newItems))
	for _, item := range existingItems {
		results = append(results, expandedItem{Content: item, Source: "existing"})
	}
	for _, item := range newItems {
		results = append(results, expandedItem{Content: item, Source: "generated"})
	}
	return results, nil
}

// unifyStyle 复刻 src/lib/ai.ts 的 unifyStyle。
func (d *Deps) unifyStyle(ctx context.Context, content, systemPrompt string, temperature float64) (string, float64, error) {
	object, err := d.generate(ctx, aiclient.ObjectRequest{
		Prompt:      systemPrompt + "\n\n请统一以下内容的写作风格。主要调整句式、用词和详略程度，保持内容信息量不变。\n\n" + content,
		Temperature: temperature,
		Schema:      jsonRaw(unifySchema),
	}, validateUnified)
	if err != nil {
		return "", 0, err
	}

	unifiedContent, err := requireString(object, "unifiedContent")
	if err != nil {
		return "", 0, err
	}
	changesCount, err := requireNumber(object, "changesCount")
	if err != nil {
		return "", 0, err
	}
	return unifiedContent, changesCount, nil
}

// generate 是 generateObject 的等价物：取客户端 → 发请求 → 解析 + 校验。
//
// 顺序照 ai.ts：getModel() 在 generateObject 之前，所以「没配置」的
// AIConfigError 先于任何解析错误抛出。
func (d *Deps) generate(ctx context.Context, req aiclient.ObjectRequest, validate func(map[string]any) error) (map[string]any, error) {
	client, err := d.newClient(ctx)
	if err != nil {
		return nil, err
	}
	text, err := client.GenerateObject(ctx, req)
	if err != nil {
		return nil, err
	}
	return decodeObject(text, validate)
}
