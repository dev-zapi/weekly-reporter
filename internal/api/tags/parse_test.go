package tags

import (
	"reflect"
	"testing"
)

// 本文件是 src/lib/tags/parse.test.ts 的 Go 同用例集（ADR-0029 / 蓝图 §5：
// 「lib server-only 单测同批走」）。parse.ts 在 cutover 前仍是 Next 的运行时代码，
// 对应的 vitest 文件不在本票的删除清单里，所以这里只是把同一批断言在 Go 侧重跑。

func TestIsValidTagName(t *testing.T) {
	accepted := []string{"工作", "tag123", "工作tag1", "123abc", "工作1", "一二三"}
	for _, name := range accepted {
		if !IsValidTagName(name) {
			t.Fatalf("IsValidTagName(%q) = false, want true", name)
		}
	}

	rejected := []string{"tag-name", "tag_name", "tag name", "", "12345", "0", "工作 任务", "#工作"}
	for _, name := range rejected {
		if IsValidTagName(name) {
			t.Fatalf("IsValidTagName(%q) = true, want false", name)
		}
	}
}

func TestParseTags(t *testing.T) {
	cases := []struct {
		content string
		want    []string
	}{
		{"今天 #工作 完成了", []string{"工作"}},
		{"#a #b", []string{"a", "b"}},
		{"#a#b", []string{}},
		{"#a\n#b", []string{"a", "b"}},
		{"#a 中的#b", []string{"a"}},
		{"#工作", []string{"工作"}},
		{"#工作1", []string{"工作1"}},
		{"内容 #tag", []string{"tag"}},
		{"#工作 #工作", []string{"工作"}},
		{"#tag-name", []string{}},
		{"#Foo #foo", []string{"Foo", "foo"}},
		{"just plain text", []string{}},
		{"\n#tag\n", []string{"tag"}},
		{"#12345", []string{}},
		{"issue #99 fixed", []string{}},
		{"#123abc", []string{"123abc"}},
		{"#一二三", []string{"一二三"}},
		{"#12345 #work #67890 #工作2", []string{"work", "工作2"}},
	}
	for _, tc := range cases {
		got := ParseTags(tc.content)
		if len(got) == 0 && len(tc.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("ParseTags(%q) = %v, want %v", tc.content, got, tc.want)
		}
	}
}

func TestRemoveTagFromContent(t *testing.T) {
	cases := []struct{ content, tag, want string }{
		{"这是内容 #tag1 #tag2", "tag1", "这是内容 #tag2"},
		{"内容  #tag1  #tag2", "tag1", "内容 #tag2"},
		{"#tag1 内容", "tag1", "内容"},
		{"内容 #tag1", "tag1", "内容"},
		{"#工作日志 #工作", "工作", "#工作日志"},
		{"line1 #tag\nline2 #tag", "tag", "line1 line2"},
		{"#tag", "tag", ""},
		{"no tags here", "tag", "no tags here"},
		{"#tag middle #tag end", "tag", "middle end"},
		{"  #tag  content", "tag", "content"},
	}
	for _, tc := range cases {
		if got := RemoveTagFromContent(tc.content, tc.tag); got != tc.want {
			t.Fatalf("RemoveTagFromContent(%q, %q) = %q, want %q", tc.content, tc.tag, got, tc.want)
		}
	}
}

func TestRenameTagInContent(t *testing.T) {
	cases := []struct{ content, oldName, newName, want string }{
		{"#old content", "old", "new", "#new content"},
		{"#oldx content", "old", "new", "#oldx content"},
		{"#工作日志 #工作", "工作", "任务", "#工作日志 #任务"},
		{"#old middle #old end", "old", "new", "#new middle #new end"},
		{"a  #old  b", "old", "new", "a  #new  b"},
	}
	for _, tc := range cases {
		if got := RenameTagInContent(tc.content, tc.oldName, tc.newName); got != tc.want {
			t.Fatalf("RenameTagInContent(%q) = %q, want %q", tc.content, got, tc.want)
		}
	}
}
