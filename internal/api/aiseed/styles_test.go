package aiseed

import "testing"

// 顺序与默认项都是契约（首次列表中 formal 在最前且是默认风格），单一数据副本
// 之外没有第二处可比对的 Go 拷贝，这里钉住内置集合的形状。
func TestStylesContract(t *testing.T) {
	wantKeys := []string{"formal", "technical", "concise", "detailed"}
	if len(Styles) != len(wantKeys) {
		t.Fatalf("Styles has %d entries, want %d", len(Styles), len(wantKeys))
	}
	defaults := 0
	for i, style := range Styles {
		if style.Key != wantKeys[i] {
			t.Errorf("Styles[%d].Key = %q, want %q", i, style.Key, wantKeys[i])
		}
		if style.Label == "" || style.SystemPrompt == "" || style.Temperature == "" {
			t.Errorf("Styles[%d] has empty field: %+v", i, style)
		}
		if style.IsDefault {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("default styles = %d, want 1", defaults)
	}
	if got := Default(); got.Key != "formal" {
		t.Fatalf("Default().Key = %q, want formal", got.Key)
	}
}
