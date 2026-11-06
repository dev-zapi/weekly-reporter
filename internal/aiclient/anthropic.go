package aiclient

import (
	"context"
	"encoding/json"
	"strings"
)

// anthropicVersion 钉回 2023-06-01，与 @ai-sdk/anthropic@4.0.16 一致。
// anthropic-sdk-go 等官方客户端默认发 2026-10-21，该版本的 Messages API 会拒绝
// temperature/top_p/top_k（ADR-0027 关键钉版），所以这里显式写死。
const anthropicVersion = "2023-06-01"

// anthropicStructuredOutputsBeta 是 output_config.format 所依赖的 beta。
const anthropicStructuredOutputsBeta = "structured-outputs-2025-11-13"

// anthropicCapabilities 复刻 @ai-sdk/anthropic@4.0.16 的 getModelCapabilities：
// one-shot 路径只依赖 max output tokens、原生结构化输出开关与
// 「拒绝采样参数」开关三项。
type anthropicCapabilities struct {
	maxOutputTokens           int64
	supportsStructuredOutput  bool
	rejectsSamplingParameters bool
}

// anthropicModels 的顺序与 dist 里 getModelCapabilities 的 if/else 链一致：
// 先匹配到的模型族赢。
func anthropicCapabilitiesFor(model string) anthropicCapabilities {
	containsAny := func(substrings ...string) bool {
		for _, substring := range substrings {
			if strings.Contains(model, substring) {
				return true
			}
		}
		return false
	}
	switch {
	case containsAny("claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-sonnet-5"):
		return anthropicCapabilities{128_000, true, true}
	case containsAny("claude-sonnet-4-6", "claude-opus-4-6"):
		return anthropicCapabilities{128_000, true, false}
	case containsAny("claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"):
		return anthropicCapabilities{64_000, true, false}
	case containsAny("claude-opus-4-1"):
		return anthropicCapabilities{32_000, true, false}
	case containsAny("claude-sonnet-4-"):
		return anthropicCapabilities{64_000, false, false}
	case containsAny("claude-opus-4-"):
		return anthropicCapabilities{32_000, false, false}
	case containsAny("claude-3-haiku"):
		return anthropicCapabilities{4_096, false, false}
	default:
		return anthropicCapabilities{4_096, false, false}
	}
}

// generateAnthropic 走 Anthropic Messages API。两条结构化输出路径与 AI SDK 一致：
//
//   - 支持原生结构化输出的模型：output_config.format（ADR-0027 §7.2）；
//   - 其余（含自定义模型名）：单个名为 json 的 function 工具，tool_choice
//     required → Anthropic 的 {type:"any"}，响应从 tool_use.input 取对象。
//
// temperature 的三种处理也照 dist：模型拒绝采样参数时不发；否则夹到 [0,1]。
func (c *Client) generateAnthropic(ctx context.Context, req ObjectRequest) (string, error) {
	capabilities := anthropicCapabilitiesFor(c.cfg.Model)

	body := map[string]any{
		"model":      c.cfg.Model,
		"max_tokens": capabilities.maxOutputTokens,
		"messages": []map[string]any{{
			"role": "user",
			"content": []map[string]any{{
				"type": "text",
				"text": req.Prompt,
			}},
		}},
	}
	if !capabilities.rejectsSamplingParameters {
		setTemperature(body, clampTemperature(req.Temperature, 0, 1))
	}

	headers := map[string]string{
		"x-api-key":         c.cfg.APIKey,
		"anthropic-version": anthropicVersion,
	}

	if capabilities.supportsStructuredOutput {
		body["output_config"] = map[string]any{
			"format": map[string]any{
				"type":   "json_schema",
				"schema": req.Schema,
			},
		}
		headers["anthropic-beta"] = anthropicStructuredOutputsBeta
	} else {
		body["tools"] = []map[string]any{{
			"name":         "json",
			"description":  "Respond with a JSON object.",
			"input_schema": req.Schema,
		}}
		body["tool_choice"] = map[string]any{
			"type":                      "any",
			"disable_parallel_tool_use": true,
		}
	}

	raw, err := c.postJSON(ctx, c.baseURL(defaultAnthropicBaseURL)+"/messages", body, headers)
	if err != nil {
		return "", err
	}

	var response struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", err
	}

	// AI SDK 把 text block 依次拼起来；json 工具路径则把 tool_use.input 当作
	// 对象文本。两条路径互斥（usesJsonResponseTool 决定是否收 text）。
	var text strings.Builder
	for _, block := range response.Content {
		if capabilities.supportsStructuredOutput {
			if block.Type == "text" {
				text.WriteString(block.Text)
			}
			continue
		}
		if block.Type == "tool_use" && block.Name == "json" && len(block.Input) > 0 {
			text.Write(block.Input)
		}
	}
	if text.Len() == 0 {
		return "", ErrNoObject
	}
	return text.String(), nil
}

// clampTemperature 复刻 AI SDK 对 anthropic temperature 的夹取（>max → max，
// <min → min）；NaN 原样保留，由 setTemperature 写成 null。
func clampTemperature(temperature, min, max float64) float64 {
	if temperature > max {
		return max
	}
	if temperature < min {
		return min
	}
	return temperature
}
