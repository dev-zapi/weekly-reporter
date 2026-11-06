package sources

import (
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/collect/collectpath"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件移植 src/lib/validations.ts 的 collectSourceSchema（zod v4）在 HTTP 层
// 可观测的形状：哪些输入算非法、issue 的 path 与 message、以及成功后的 transform。
// 判定顺序照 zod：先顶层 object 类型检查，再按 shape 顺序逐字段收集 issue；
// 没有 issue 时才跑 refine（remote 必须有 repo/token），最后跑 transform。

// issue 是 zod issue 的最小投影；route.ts 只回 path.join('.') 与 message。
type issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// collectSourceInput 是 collectSourceSchema.parse 的成功输出（zod 已剥掉未知键）。
type collectSourceInput struct {
	Type         string
	Name         string
	ProjectScope string
	Aliases      []string
	HasAliases   bool
	Config       configInput
	Enabled      *bool
}

type configInput struct {
	BaseURL          *string
	Owner            string
	Repo             *string
	Token            *string
	AuthorEmails     []string
	Branches         []branchEntry
	HasBranches      bool
	BranchCursors    []branchCursorEntry
	HasBranchCursors bool
}

// branchEntry 是 branches 数组的元素：字符串或 {name, lastCommitTime?}。
type branchEntry struct {
	IsString bool
	String   string
	// Object 形态（IsString=false）。
	Name              string
	HasLastCommitTime bool
	LastCommitTime    *string
}

type branchCursorEntry struct {
	Name              string
	HasLastCommitTime bool
	LastCommitTime    *string
}

var (
	collectSourceTypes = []string{"git-remote-github", "git-remote-gitlab", "git-remote-gitee", "git-local"}
	projectScopes      = []string{"work", "personal"}
	validStatuses      = []string{"enabled", "disabled", "unavailable"}
)

const (
	errRequiredName       = "Source name is required"
	errRequiredOwner      = "Path or owner is required"
	errRequiredEmails     = "At least one author email is required"
	errRequiredRepo       = "A repository is required for remote sources"
	errRequiredToken      = "A token is required for remote sources"
	errTooBigString100    = "Too big: expected string to have <=100 characters"
	errTooSmallString1    = "Too small: expected string to have >=1 characters"
	errTooManyAliases     = "Too big: expected array to have <=20 items"
	enumMessageSourceType = `Invalid option: expected one of "git-remote-github"|"git-remote-gitlab"|"git-remote-gitee"|"git-local"`
	enumMessageScope      = `Invalid option: expected one of "work"|"personal"`
)

func typeMessage(expected string, value any) string {
	return "Invalid input: expected " + expected + ", received " + jsonTypeName(value)
}

func indexSegment(index int) string {
	return itoa(index)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func appendSegment(path []string, segment string) []string {
	return append(append([]string{}, path...), segment)
}

func pathString(path []string) string { return strings.Join(path, ".") }

// validateCollectSource 复刻 `collectSourceSchema.parse(body)`。
// issues 非空时返回的 input 无意义（zod 的 parse 会抛错）。
func validateCollectSource(body any) (collectSourceInput, []issue) {
	var input collectSourceInput
	object, ok := jsObject(body)
	if !ok {
		return input, []issue{{Path: "", Message: typeMessage("object", body)}}
	}

	var issues []issue
	add := func(path []string, message string) {
		issues = append(issues, issue{Path: pathString(path), Message: message})
	}

	// type: z.enum([...]) —— 任何非枚举值（含缺失/非字符串）都是同一条 message。
	if value, present := object["type"]; !present || !isEnumValue(value, collectSourceTypes) {
		add([]string{"type"}, enumMessageSourceType)
	} else {
		input.Type = value.(string)
	}

	// name: z.string().min(1, 自定义).max(100)
	input.Name = validateStringField(object, "name", []string{"name"}, 1, errRequiredName, 100, add)

	// projectScope: z.enum(['work','personal'])
	if value, present := object["projectScope"]; !present || !isEnumValue(value, projectScopes) {
		add([]string{"projectScope"}, enumMessageScope)
	} else {
		input.ProjectScope = value.(string)
	}

	// aliases: z.array(z.string().min(1).max(100)).max(20).optional()
	if value, present := object["aliases"]; present {
		input.HasAliases = true
		if items, ok := value.([]any); !ok {
			add([]string{"aliases"}, typeMessage("array", value))
		} else {
			for i, item := range items {
				text, ok := item.(string)
				if !ok {
					add(appendSegment([]string{"aliases"}, indexSegment(i)), typeMessage("string", item))
					continue
				}
				switch length := jsstr.UTF16Len(text); {
				case length < 1:
					add(appendSegment([]string{"aliases"}, indexSegment(i)), errTooSmallString1)
				case length > 100:
					add(appendSegment([]string{"aliases"}, indexSegment(i)), errTooBigString100)
				default:
					input.Aliases = append(input.Aliases, text)
				}
			}
			if len(items) > 20 {
				add([]string{"aliases"}, errTooManyAliases)
			}
		}
	}

	// config: z.object({...})
	if value, present := object["config"]; !present {
		add([]string{"config"}, typeMessage("object", jsUndefined))
	} else if configObject, ok := jsObject(value); ok {
		input.Config = validateConfig(configObject, add)
	} else {
		add([]string{"config"}, typeMessage("object", value))
	}

	// enabled: z.boolean().optional()
	if value, present := object["enabled"]; present {
		if flag, ok := value.(bool); ok {
			input.Enabled = &flag
		} else {
			add([]string{"enabled"}, typeMessage("boolean", value))
		}
	}

	if len(issues) > 0 {
		return input, issues
	}

	// refine：remote 必须有非空 repo / token（两条都收集）
	if input.Type != "git-local" {
		if input.Config.Repo == nil || *input.Config.Repo == "" {
			issues = append(issues, issue{Path: "config.repo", Message: errRequiredRepo})
		}
		if input.Config.Token == nil || *input.Config.Token == "" {
			issues = append(issues, issue{Path: "config.token", Message: errRequiredToken})
		}
		if len(issues) > 0 {
			return input, issues
		}
	}

	// transform：git-local 的 owner 做路径展开 + 去结尾斜杠
	if input.Type == "git-local" {
		input.Config.Owner = stripTrailingSlash(collectpath.ExpandInputPath(input.Config.Owner))
	}
	return input, nil
}

// validateStringField 复刻 z.string().min(minLength, minMessage).max(maxLength)。
// maxLength <= 0 表示该字段没有上限（config.owner）。
func validateStringField(object map[string]any, key string, path []string, minLength int, minMessage string, maxLength int, add func([]string, string)) string {
	value, present := object[key]
	if !present {
		add(path, typeMessage("string", jsUndefined))
		return ""
	}
	text, ok := value.(string)
	if !ok {
		add(path, typeMessage("string", value))
		return ""
	}
	length := jsstr.UTF16Len(text)
	if length < minLength {
		add(path, minMessage)
		return ""
	}
	if maxLength > 0 && length > maxLength {
		add(path, errTooBigString100)
		return ""
	}
	return text
}

func validateConfig(object map[string]any, add func([]string, string)) configInput {
	var config configInput
	configPath := []string{"config"}

	// baseUrl: z.string().optional()
	if value, present := object["baseUrl"]; present {
		if text, ok := value.(string); ok {
			config.BaseURL = &text
		} else {
			add(appendSegment(configPath, "baseUrl"), typeMessage("string", value))
		}
	}

	// owner: z.string().min(1, 'Path or owner is required')
	config.Owner = validateStringField(object, "owner", appendSegment(configPath, "owner"), 1, errRequiredOwner, 0, add)

	// repo / token: z.string().optional()
	for _, field := range []struct {
		name string
		dest **string
	}{{"repo", &config.Repo}, {"token", &config.Token}} {
		if value, present := object[field.name]; present {
			if text, ok := value.(string); ok {
				*field.dest = &text
			} else {
				add(appendSegment(configPath, field.name), typeMessage("string", value))
			}
		}
	}

	// authorEmails: z.array(z.string()).min(1, 自定义)
	if value, present := object["authorEmails"]; !present {
		add(appendSegment(configPath, "authorEmails"), typeMessage("array", jsUndefined))
	} else if items, ok := value.([]any); !ok {
		add(appendSegment(configPath, "authorEmails"), typeMessage("array", value))
	} else {
		for i, item := range items {
			text, ok := item.(string)
			if !ok {
				add(appendSegment(appendSegment(configPath, "authorEmails"), indexSegment(i)), typeMessage("string", item))
				continue
			}
			config.AuthorEmails = append(config.AuthorEmails, text)
		}
		if len(items) < 1 {
			add(appendSegment(configPath, "authorEmails"), errRequiredEmails)
		}
	}

	// branches: z.array(z.union([z.string(), z.object({...})])).optional()
	if value, present := object["branches"]; present {
		config.HasBranches = true
		if items, ok := value.([]any); !ok {
			add(appendSegment(configPath, "branches"), typeMessage("array", value))
		} else {
			for i, item := range items {
				entry, ok := parseBranchEntry(item)
				if !ok {
					add(appendSegment(appendSegment(configPath, "branches"), indexSegment(i)), "Invalid input")
					continue
				}
				config.Branches = append(config.Branches, entry)
			}
		}
	}

	// branchCursors: z.array(z.object({name, lastCommitTime?})).optional()
	if value, present := object["branchCursors"]; present {
		config.HasBranchCursors = true
		if items, ok := value.([]any); !ok {
			add(appendSegment(configPath, "branchCursors"), typeMessage("array", value))
		} else {
			for i, item := range items {
				entry, fieldIssues := parseBranchCursorEntry(item)
				basePath := appendSegment(configPath, "branchCursors")
				basePath = appendSegment(basePath, indexSegment(i))
				for _, fieldIssue := range fieldIssues {
					if fieldIssue.Path == "" {
						add(basePath, fieldIssue.Message)
						continue
					}
					add(appendSegment(basePath, fieldIssue.Path), fieldIssue.Message)
				}
				if len(fieldIssues) == 0 {
					config.BranchCursors = append(config.BranchCursors, entry)
				}
			}
		}
	}

	return config
}

func parseBranchEntry(item any) (branchEntry, bool) {
	if text, ok := item.(string); ok {
		return branchEntry{IsString: true, String: text}, true
	}
	object, ok := jsObject(item)
	if !ok {
		return branchEntry{}, false
	}
	name, ok := object["name"].(string)
	if !ok {
		return branchEntry{}, false
	}
	entry := branchEntry{Name: name}
	if value, present := object["lastCommitTime"]; present {
		if value == nil {
			entry.HasLastCommitTime = true
		} else if text, ok := value.(string); ok {
			entry.HasLastCommitTime = true
			entry.LastCommitTime = &text
		} else {
			return branchEntry{}, false
		}
	}
	return entry, true
}

// parseBranchCursorEntry 返回的字段 issue 的 Path 只是对象内的相对字段名。
func parseBranchCursorEntry(item any) (branchCursorEntry, []issue) {
	object, ok := jsObject(item)
	if !ok {
		return branchCursorEntry{}, []issue{{Path: "", Message: typeMessage("object", item)}}
	}
	var issues []issue
	entry := branchCursorEntry{}
	if value, present := object["name"]; !present {
		issues = append(issues, issue{Path: "name", Message: typeMessage("string", jsUndefined)})
	} else if text, ok := value.(string); ok {
		entry.Name = text
	} else {
		issues = append(issues, issue{Path: "name", Message: typeMessage("string", value)})
	}
	if value, present := object["lastCommitTime"]; present {
		if value == nil {
			entry.HasLastCommitTime = true
		} else if text, ok := value.(string); ok {
			entry.HasLastCommitTime = true
			entry.LastCommitTime = &text
		} else {
			issues = append(issues, issue{Path: "lastCommitTime", Message: typeMessage("string", value)})
		}
	}
	return entry, issues
}

func isEnumValue(value any, allowed []string) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	for _, candidate := range allowed {
		if text == candidate {
			return true
		}
	}
	return false
}
