package aiclient

import "testing"

// base URL 处理逐条对照 @ai-sdk/anthropic 的 normalizeBaseURL 与 provider.ts 的
// withoutTrailingSlash。用包内测试直接断言拼好的 base，避免为了验证默认地址去
// 碰公网。
func TestAnthropicBaseURL(t *testing.T) {
	cases := []struct {
		configured string
		want       string
	}{
		{"", "https://api.anthropic.com/v1"},
		{"https://api.anthropic.com", "https://api.anthropic.com/v1"},
		{"https://api.anthropic.com/", "https://api.anthropic.com/v1"},
		{"http://127.0.0.1:4000/anthropic", "http://127.0.0.1:4000/anthropic"},
		{"http://127.0.0.1:4000/anthropic/", "http://127.0.0.1:4000/anthropic"},
	}
	for _, tc := range cases {
		client := New(Config{Protocol: ProtocolAnthropic, BaseURL: tc.configured})
		if got := client.anthropicBaseURL(); got != tc.want {
			t.Errorf("configured %q: base = %q, want %q", tc.configured, got, tc.want)
		}
	}
}

func TestOpenAIBaseURL(t *testing.T) {
	cases := []struct {
		configured string
		want       string
	}{
		{"", "https://api.openai.com/v1"},
		{"http://127.0.0.1:4000/v1", "http://127.0.0.1:4000/v1"},
		{"http://127.0.0.1:4000/v1/", "http://127.0.0.1:4000/v1"},
	}
	for _, tc := range cases {
		client := New(Config{Protocol: ProtocolOpenAI, BaseURL: tc.configured})
		if got := client.baseURL(defaultOpenAIBaseURL); got != tc.want {
			t.Errorf("configured %q: base = %q, want %q", tc.configured, got, tc.want)
		}
	}
}
