package sources

import (
	"os"
	"path"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件移植 src/lib/collect/paths.ts 与 realpath.ts 的 server-only 语义。
// 这两份 TS 也被 client 代码 import（表单的目录补全），所以 vitest 侧保留；
// Go 侧只实现本域 route.ts 用到的部分。

// expandInputPath 复刻路径展开：`~` / `~/` 开头展开为 $HOME，相对路径解析到
// $HOME 下，绝对路径原样使用。返回值经 resolve 规范化，但保留用户输入的结尾
// 斜杠（目录补全靠它区分「列出该目录内容」）。
func expandInputPath(input string) string {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/home"
	}
	trimmed := jsstr.Trim(input)

	var expanded string
	switch {
	case trimmed == "~":
		expanded = home
	case strings.HasPrefix(trimmed, "~/"):
		expanded = resolvePath(home, trimmed[2:])
	case strings.HasPrefix(trimmed, "/"):
		expanded = resolvePath(trimmed)
	default:
		expanded = resolvePath(home, trimmed)
	}

	if strings.HasSuffix(trimmed, "/") && expanded != "/" {
		return expanded + "/"
	}
	return expanded
}

// resolvePath 复刻 Node path.resolve 的 POSIX 语义：从右往左拼接，遇到绝对
// 路径即重置，最后 clean。第一个参数在调用处总是绝对的 $HOME，所以不会落到
// process.cwd() 分支。
func resolvePath(parts ...string) string {
	current := ""
	absolute := false
	for i := len(parts) - 1; i >= 0; i-- {
		part := parts[i]
		if part == "" {
			continue
		}
		if strings.HasPrefix(part, "/") {
			current = part + "/" + current
			absolute = true
			break
		}
		if current == "" {
			current = part
		} else {
			current = part + "/" + current
		}
	}
	if !absolute {
		current = "/" + current
	}
	cleaned := path.Clean(current)
	if cleaned == "" {
		return "/"
	}
	return cleaned
}

// stripTrailingSlash 复刻 `p.replace(/(.)\/+$/, '$1')`：去掉结尾斜杠但保留根
// 路径的单个 '/'。
func stripTrailingSlash(p string) string {
	for len(p) > 1 && strings.HasSuffix(p, "/") {
		p = p[:len(p)-1]
	}
	return p
}

// tryRealpath 复刻 fs.promises.realpath 的「失败返回 null」包装。
// filepath.EvalSymlinks 与 realpath 同义：路径不存在/无权限都返回错误。
func tryRealpath(p string) *string {
	resolved, err := evalSymlinks(p)
	if err != nil {
		return nil
	}
	return &resolved
}
