package origin

import "testing"

// 用例逐条对照 src/lib/template/origin-group.ts 的注释与实现。

func ptr(v int64) *int64 { return &v }

func TestGetOriginGroupWithoutSourceIsManual(t *testing.T) {
	if got := GetOriginGroup(nil, map[int64]ProjectScope{1: ScopeWork}); got != GroupManual {
		t.Fatalf("got %q, want manual", got)
	}
}

func TestGetOriginGroupUsesScopeMapping(t *testing.T) {
	scopes := map[int64]ProjectScope{1: ScopeWork, 2: ScopePersonal}

	if got := GetOriginGroup(ptr(1), scopes); got != GroupWork {
		t.Fatalf("source 1 = %q, want work", got)
	}
	if got := GetOriginGroup(ptr(2), scopes); got != GroupPersonal {
		t.Fatalf("source 2 = %q, want personal", got)
	}
}

// sourceId 没有命中（采集源已删除）→ other，而不是 manual。
func TestGetOriginGroupUnknownSourceIsOther(t *testing.T) {
	if got := GetOriginGroup(ptr(42), map[int64]ProjectScope{1: ScopeWork}); got != GroupOther {
		t.Fatalf("got %q, want other", got)
	}
	if got := GetOriginGroup(ptr(42), nil); got != GroupOther {
		t.Fatalf("got %q, want other with nil map", got)
	}
}

func TestOriginGroupRank(t *testing.T) {
	// 组间固定优先级：手动组 > 采集-工作组 > 采集-个人组 > 其他组。
	order := []OriginGroup{GroupManual, GroupWork, GroupPersonal, GroupOther}
	for i := 1; i < len(order); i++ {
		if OriginGroupRank[order[i-1]] >= OriginGroupRank[order[i]] {
			t.Fatalf("rank order broken at %q/%q", order[i-1], order[i])
		}
	}
}
