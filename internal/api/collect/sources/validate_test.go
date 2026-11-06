package sources

import (
	"encoding/json"
	"reflect"
	"testing"
)

// 本文件用真实 zod v4 的输出做基准（在施工机上用 schema 的 safeParse 逐条打印），
// 断言 Go 移植的 issue 列表逐条一致：同 path、同 message、同顺序。

type issuePair struct {
	Path    string
	Message string
}

func issuesOf(t *testing.T, body string) ([]issuePair, bool) {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(body), &value); err != nil {
		t.Fatalf("decode fixture %s: %v", body, err)
	}
	_, issues := validateCollectSource(value)
	pairs := make([]issuePair, 0, len(issues))
	for _, item := range issues {
		pairs = append(pairs, issuePair{Path: item.Path, Message: item.Message})
	}
	return pairs, len(pairs) == 0
}

func TestValidateCollectSourceMatchesZod(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []issuePair
	}{
		{
			name: "empty object",
			body: `{}`,
			want: []issuePair{
				{"type", `Invalid option: expected one of "git-remote-github"|"git-remote-gitlab"|"git-remote-gitee"|"git-local"`},
				{"name", "Invalid input: expected string, received undefined"},
				{"projectScope", `Invalid option: expected one of "work"|"personal"`},
				{"config", "Invalid input: expected object, received undefined"},
			},
		},
		{
			name: "top-level array",
			body: `[1,2]`,
			want: []issuePair{{"", "Invalid input: expected object, received array"}},
		},
		{
			name: "top-level null",
			body: `null`,
			want: []issuePair{{"", "Invalid input: expected object, received null"}},
		},
		{
			name: "bad type",
			body: `{"type":"nope"}`,
			want: []issuePair{
				{"type", `Invalid option: expected one of "git-remote-github"|"git-remote-gitlab"|"git-remote-gitee"|"git-local"`},
				{"name", "Invalid input: expected string, received undefined"},
				{"projectScope", `Invalid option: expected one of "work"|"personal"`},
				{"config", "Invalid input: expected object, received undefined"},
			},
		},
		{
			name: "empty name",
			body: `{"type":"git-local","name":"","projectScope":"work","config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"name", "Source name is required"}},
		},
		{
			name: "long name",
			body: `{"type":"git-local","name":"` + repeat("x", 101) + `","projectScope":"work","config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"name", "Too big: expected string to have <=100 characters"}},
		},
		{
			name: "bad scope",
			body: `{"type":"git-local","name":"n","projectScope":"bad","config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"projectScope", `Invalid option: expected one of "work"|"personal"`}},
		},
		{
			name: "empty alias string",
			body: `{"type":"git-local","name":"n","projectScope":"work","aliases":[""],"config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"aliases.0", "Too small: expected string to have >=1 characters"}},
		},
		{
			name: "too many aliases",
			body: `{"type":"git-local","name":"n","projectScope":"work","aliases":` + manyAliases(21, "") + `,"config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"aliases", "Too big: expected array to have <=20 items"}},
		},
		{
			name: "aliases not array",
			body: `{"type":"git-local","name":"n","projectScope":"work","aliases":"x","config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"aliases", "Invalid input: expected array, received string"}},
		},
		{
			name: "owner empty",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"","authorEmails":["e"]}}`,
			want: []issuePair{{"config.owner", "Path or owner is required"}},
		},
		{
			name: "emails empty",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":[]}}`,
			want: []issuePair{{"config.authorEmails", "At least one author email is required"}},
		},
		{
			name: "emails missing",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o"}}`,
			want: []issuePair{{"config.authorEmails", "Invalid input: expected array, received undefined"}},
		},
		{
			name: "remote without repo",
			body: `{"type":"git-remote-github","name":"n","projectScope":"work","config":{"owner":"o","token":"t","authorEmails":["e"]}}`,
			want: []issuePair{{"config.repo", "A repository is required for remote sources"}},
		},
		{
			name: "remote empty repo",
			body: `{"type":"git-remote-github","name":"n","projectScope":"work","config":{"owner":"o","repo":"","token":"t","authorEmails":["e"]}}`,
			want: []issuePair{{"config.repo", "A repository is required for remote sources"}},
		},
		{
			name: "remote without token",
			body: `{"type":"git-remote-github","name":"n","projectScope":"work","config":{"owner":"o","repo":"r","authorEmails":["e"]}}`,
			want: []issuePair{{"config.token", "A token is required for remote sources"}},
		},
		{
			name: "both refines fail",
			body: `{"type":"git-remote-github","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{
				{"config.repo", "A repository is required for remote sources"},
				{"config.token", "A token is required for remote sources"},
			},
		},
		{
			name: "enabled not boolean",
			body: `{"type":"git-local","name":"n","projectScope":"work","enabled":"yes","config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"enabled", "Invalid input: expected boolean, received string"}},
		},
		{
			name: "branch entry not string or object",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":["e"],"branches":[1]}}`,
			want: []issuePair{{"config.branches.0", "Invalid input"}},
		},
		{
			name: "branch object missing name",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":["e"],"branches":[{"lastCommitTime":"x"}]}}`,
			want: []issuePair{{"config.branches.0", "Invalid input"}},
		},
		{
			name: "branch cursor missing name",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":["e"],"branchCursors":[{"lastCommitTime":null}]}}`,
			want: []issuePair{{"config.branchCursors.0.name", "Invalid input: expected string, received undefined"}},
		},
		{
			name: "branch cursor not object",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":["e"],"branchCursors":[1]}}`,
			want: []issuePair{{"config.branchCursors.0", "Invalid input: expected object, received number"}},
		},
		{
			name: "branches not array",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":["e"],"branches":"x"}}`,
			want: []issuePair{{"config.branches", "Invalid input: expected array, received string"}},
		},
		{
			name: "email element not string",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":{"owner":"o","authorEmails":[1]}}`,
			want: []issuePair{{"config.authorEmails.0", "Invalid input: expected string, received number"}},
		},
		{
			name: "config not object",
			body: `{"type":"git-local","name":"n","projectScope":"work","config":"x"}`,
			want: []issuePair{{"config", "Invalid input: expected object, received string"}},
		},
		{
			name: "alias element not string",
			body: `{"type":"git-local","name":"n","projectScope":"work","aliases":[1],"config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"aliases.0", "Invalid input: expected string, received number"}},
		},
		{
			name: "enabled null",
			body: `{"type":"git-local","name":"n","projectScope":"work","enabled":null,"config":{"owner":"o","authorEmails":["e"]}}`,
			want: []issuePair{{"enabled", "Invalid input: expected boolean, received null"}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := issuesOf(t, tc.body)
			if len(tc.want) == 0 {
				if !ok {
					t.Fatalf("unexpected issues: %+v", got)
				}
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("issues = %+v\nwant    %+v", got, tc.want)
			}
		})
	}
}

func TestValidateCollectSourceTransformsGitLocalOwner(t *testing.T) {
	t.Setenv("HOME", "/home/tester")
	input, issues := validateCollectSource(map[string]any{
		"type":         "git-local",
		"name":         "n",
		"projectScope": "work",
		"config": map[string]any{
			"owner":        "~/repo/",
			"authorEmails": []any{"e"},
		},
	})
	if len(issues) > 0 {
		t.Fatalf("issues = %+v", issues)
	}
	if input.Config.Owner != "/home/tester/repo" {
		t.Fatalf("owner = %q", input.Config.Owner)
	}
}

func TestValidateCollectSourceKeepsRemoteOwnerVerbatim(t *testing.T) {
	input, issues := validateCollectSource(map[string]any{
		"type":         "git-remote-github",
		"name":         "n",
		"projectScope": "work",
		"config": map[string]any{
			"owner":        "org/",
			"repo":         "r",
			"token":        "t",
			"authorEmails": []any{"e"},
		},
	})
	if len(issues) > 0 {
		t.Fatalf("issues = %+v", issues)
	}
	if input.Config.Owner != "org/" {
		t.Fatalf("owner = %q", input.Config.Owner)
	}
}

func repeat(value string, count int) string {
	result := ""
	for i := 0; i < count; i++ {
		result += value
	}
	return result
}

func manyAliases(count int, value string) string {
	encoded, err := json.Marshal(func() []string {
		values := make([]string, count)
		for i := range values {
			values[i] = value + itoa(i)
		}
		return values
	}())
	if err != nil {
		panic(err)
	}
	return string(encoded)
}
