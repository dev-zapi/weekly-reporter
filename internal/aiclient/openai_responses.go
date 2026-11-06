package aiclient

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// generateResponses 走 OpenAI Responses API。@ai-sdk/openai 的默认模型入口
// （openai(model)）就是这条；结构化输出放在 text.format。
//
// 请求形状照 createOpenAIProvider 的 baseArgs：input 是「单条 user 消息 + 一个
// input_text part」，text.format 带 strict:true（AI SDK 的 strictJsonSchema 默认值）。
func (c *Client) generateResponses(ctx context.Context, req ObjectRequest) (string, error) {
	body := map[string]any{
		"model": c.cfg.Model,
		"input": []map[string]any{{
			"role": "user",
			"content": []map[string]any{{
				"type": "input_text",
				"text": req.Prompt,
			}},
		}},
		"text": map[string]any{
			"format": map[string]any{
				"type":   "json_schema",
				"strict": true,
				"name":   "response",
				"schema": req.Schema,
			},
		},
	}
	setTemperature(body, req.Temperature)

	base, err := c.baseURL(defaultOpenAIBaseURL)
	if err != nil {
		return "", err
	}

	raw, err := c.postJSON(ctx, base+"/responses", body, map[string]string{
		"Authorization": "Bearer " + c.cfg.APIKey,
	})
	if err != nil {
		return "", err
	}

	var response struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Output []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", err
	}
	if response.Error != nil {
		// AI SDK 在这里抛 APICallError(status 400)。one-shot 只看错误文本，
		// 与 route.ts 的 500 details 一致。
		return "", &StatusError{StatusCode: http.StatusBadRequest, Body: response.Error.Message}
	}

	var text strings.Builder
	for _, item := range response.Output {
		if item.Type != "message" {
			continue
		}
		for _, part := range item.Content {
			if part.Type == "output_text" {
				text.WriteString(part.Text)
			}
		}
	}
	if text.Len() == 0 {
		return "", ErrNoObject
	}
	return text.String(), nil
}
