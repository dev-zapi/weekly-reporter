package aiclient

import (
	"context"
	"encoding/json"
)

// generateChatCompletions 走 OpenAI Chat Completions API，对应 @ai-sdk/openai 的
// openai.chat(model)（ai_config.protocol = "openai-compatible"）。
//
// 兼容代理的 reasoning 标记 hack 只改写 text/event-stream 响应，one-shot 是普通
// JSON，不受影响（provider.ts 的 createReasoningCompatibleFetch 只在 SSE 时介入）。
func (c *Client) generateChatCompletions(ctx context.Context, req ObjectRequest) (string, error) {
	body := map[string]any{
		"model": c.cfg.Model,
		"messages": []map[string]any{{
			"role":    "user",
			"content": req.Prompt,
		}},
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "response",
				"strict": true,
				"schema": req.Schema,
			},
		},
	}
	setTemperature(body, req.Temperature)

	base, err := c.baseURL(defaultOpenAIBaseURL)
	if err != nil {
		return "", err
	}

	raw, err := c.postJSON(ctx, base+"/chat/completions", body, map[string]string{
		"Authorization": "Bearer " + c.cfg.APIKey,
	})
	if err != nil {
		return "", err
	}

	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", err
	}
	if len(response.Choices) == 0 || response.Choices[0].Message.Content == "" {
		return "", ErrNoObject
	}
	return response.Choices[0].Message.Content, nil
}
