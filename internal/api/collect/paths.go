package collect

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件是 src/lib/collect/paths.ts 与 scan-path/route.ts 里路径语义的 Go 对应物：
// 路径展开（CONTEXT.md「路径展开」）与目录白名单（蓝图 §5 B4）。

// expandInputPath 复刻 src/lib/collect/paths.ts 的 expandInputPath。
//
//   - `~` 或 `~/` 开头 → $HOME（不支持 ~user）
//   - 相对路径 → 解析到 $HOME 下
//   - 绝对路径 → 原样 resolve
//
// 返回值经 resolve 规范化，但保留用户输入的结尾斜杠（调用方用它区分「列出该目录
// 内容」）。输入先去首尾空白，用的是 JS 的 trim 语义。
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
		expanded = resolvePath(resolveUnder(home, trimmed[2:]))
	case filepath.IsAbs(trimmed):
		expanded = resolvePath(trimmed)
	default:
		expanded = resolvePath(resolveUnder(home, trimmed))
	}

	if strings.HasSuffix(trimmed, "/") && expanded != "/" {
		return expanded + "/"
	}
	return expanded
}

// resolvePath 复刻 node 的 path.resolve(p)：以进程工作目录为基准规范化成绝对路径。
func resolvePath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		// 只有拿不到工作目录时才会失败；path.resolve 在这种情况下同样无意义。
		return filepath.Clean(p)
	}
	return abs
}

// resolveUnder 复刻 `path.resolve(base, value)`：value 是绝对路径时替换 base，
// 否则在 base 之下解析。filepath.Join 单独用不行——它会把绝对 value 也接到 base
// 后面，而 node 的 resolve 遇到绝对段会丢弃之前的段。
func resolveUnder(base, value string) string {
	if filepath.IsAbs(value) {
		return value
	}
	return filepath.Join(base, value)
}

// allowedBaseDirs 复刻 scan-path/route.ts 的 ALLOWED_BASE_DIRS：
// $HOME、/home、/opt、/srv、/var、/tmp。HOME 未设置时该条目不参与。
func allowedBaseDirs() []string {
	dirs := make([]string, 0, 6)
	if home := os.Getenv("HOME"); home != "" {
		dirs = append(dirs, home)
	}
	return append(dirs, "/home", "/opt", "/srv", "/var", "/tmp")
}

// isPathAllowed 复刻 route.ts 的 isPathAllowed：解析后的路径必须等于某个白名单
// 目录，或位于其下（按 `/` 分段比较，`/various` 不算在 `/var` 下）。
func isPathAllowed(p string) bool {
	resolved := resolvePath(p)
	for _, base := range allowedBaseDirs() {
		if resolved == base || strings.HasPrefix(resolved, base+"/") {
			return true
		}
	}
	return false
}
