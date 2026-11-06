// Package collectpath 复刻采集域三条路由族（`/collect/sources`、git 执行面、
// 两条增补 POST）共用的路径语义，唯一事实源是 src/lib/collect/paths.ts。
//
// 为什么单独成包：B4 的三张票并行落地时各自带了一份 expandInputPath / path.resolve
// 的私有实现。CONTEXT.md「路径展开」写明这是「对所有接受路径输入的入口一致生效」
// 的**单一规则**，三份拷贝一旦漂移就是违约；`respond` 与 `jsstr`/`jsparse`/`jsdate`
// 已是同类先例（跨域共享的小包只为一两条冻结语义而存在）。
//
// 白名单**不在本包**：`scan-path/route.ts` 是「模板目录分段比较 + 显式含 /home」，
// `actions.ts` 是「裸前缀 + HOME 缺省回落 /home」，两者语义确有差异，各自保留显式
// 判定函数并注明事实源；只有共同的尾部条目在这里（StandardBaseDirs）。
package collectpath

import (
	"os"
	"path"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// StandardBaseDirs 是两份 TS 白名单共有的尾部条目（scan-path/route.ts 的 Set 与
// actions.ts 的数组都是这四条）。只读：调用方 append 到自己的切片时不要直接
// append 到它上面。
var StandardBaseDirs = []string{"/opt", "/srv", "/var", "/tmp"}

// HomeDir 复刻 `process.env.HOME || '/home'`。
func HomeDir() string {
	if home := os.Getenv("HOME"); home != "" {
		return home
	}
	return "/home"
}

// Resolve 复刻 Node 的 `path.resolve(...parts)` 的 POSIX 语义：从右往左拼接，
// 遇到绝对路径即重置，没有绝对段时以进程工作目录为基准，最后 clean。
//
// 不能直接用 filepath.Join：它会把绝对 part 也接到前面，而 resolve 遇到绝对段会
// 丢弃之前的段。
func Resolve(parts ...string) string {
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
		// resolve 无绝对段时补上 cwd；拿不到 cwd 才退化成根相对（route.ts 里不会发生）。
		if cwd, err := os.Getwd(); err == nil {
			current = cwd + "/" + current
		} else {
			current = "/" + current
		}
	}
	cleaned := path.Clean(current)
	if cleaned == "" {
		return "/"
	}
	return cleaned
}

// ExpandInputPath 复刻 src/lib/collect/paths.ts 的 expandInputPath：
//
//   - `~` 或 `~/` 开头 → $HOME（不支持 ~user）
//   - 相对路径 → 解析到 $HOME 下
//   - 绝对路径 → 原样 resolve
//
// 返回值经 resolve 规范化，但保留用户输入的结尾斜杠——调用方（目录补全、lookup）
// 用它区分「列出该目录内容」。输入先去首尾空白，用 JS 的 trim 语义（jsstr.Trim）。
func ExpandInputPath(input string) string {
	home := HomeDir()
	trimmed := jsstr.Trim(input)

	var expanded string
	switch {
	case trimmed == "~":
		expanded = home
	case strings.HasPrefix(trimmed, "~/"):
		expanded = Resolve(home, trimmed[2:])
	case strings.HasPrefix(trimmed, "/"):
		expanded = Resolve(trimmed)
	default:
		expanded = Resolve(home, trimmed)
	}

	if strings.HasSuffix(trimmed, "/") && expanded != "/" {
		return expanded + "/"
	}
	return expanded
}
