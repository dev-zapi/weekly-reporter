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
		// SDK 的 withoutTrailingSlash 是 `url.replace(/\/$/, "")`：只去一个。
		{"http://127.0.0.1:4000/anthropic//", "http://127.0.0.1:4000/anthropic/"},
		// 双尾斜杠的裸域名不命中 normalizeBaseURL 的裸域名改写（与 SDK 一致）。
		{"https://api.anthropic.com//", "https://api.anthropic.com/"},
	}
	for _, tc := range cases {
		client := New(Config{Protocol: ProtocolAnthropic, BaseURL: tc.configured})
		got, err := client.anthropicBaseURL()
		if err != nil {
			t.Errorf("configured %q: unexpected error %v", tc.configured, err)
			continue
		}
		if got != tc.want {
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
		// 只去一个尾斜杠：双尾斜杠保留一个，请求路径因此是 ".../v1//responses"。
		{"http://127.0.0.1:4000/v1//", "http://127.0.0.1:4000/v1/"},
		// 纯空白 = SDK 的 validateBaseURL 抛错形态。
		{"   ", ""},
	}
	for _, tc := range cases {
		client := New(Config{Protocol: ProtocolOpenAI, BaseURL: tc.configured})
		got, err := client.baseURL(defaultOpenAIBaseURL)
		if tc.want == "" {
			if err == nil {
				t.Errorf("configured %q: want error, got base %q", tc.configured, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("configured %q: unexpected error %v", tc.configured, err)
			continue
		}
		if got != tc.want {
			t.Errorf("configured %q: base = %q, want %q", tc.configured, got, tc.want)
		}
	}
}
