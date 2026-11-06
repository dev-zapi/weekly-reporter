package additions

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件提供两条增补路由需要的路径语义：
//   - expandInputPath：src/lib/collect/paths.ts 的 1:1 移植；
//   - 白名单：src/app/collect/actions.ts 的 ALLOWED_BASE_DIRS / isPathAllowed。
//
// #117（git 采集执行面）按票负责 src/lib/collect 的共享移植；B4 两票并行施工，
// 本包先自带最小私有实现以免跨票符号冲突，合并后若共享包落地可直接替换，
// 行为契约不变。

// homeDir 复刻 actions.ts 的 `process.env.HOME || '/home'`。
func homeDir() string {
	if home := os.Getenv("HOME"); home != "" {
		return home
	}
	return "/home"
}

// allowedBaseDirs 复刻 actions.ts 的 ALLOWED_BASE_DIRS：
//
//	[process.env.HOME || '/home', '/opt', '/srv', '/var', '/tmp']
//
// 与 scan-path route.ts 那个 Set（显式含 '/home' 并去重）不同：actions.ts 是
// 数组且 HOME 缺省时回落 '/home'，本票以 actions.ts 为唯一事实源。
func allowedBaseDirs() []string {
	return []string{homeDir(), "/opt", "/srv", "/var", "/tmp"}
}

// isPathAllowed 复刻 actions.ts 的 isPathAllowed：path.resolve 之后做裸前缀比较。
//
// 注意这里是 `startsWith(baseDir)`，不是 scan-path route 的
// `=== baseDir || startsWith(baseDir + '/')`——票面要求「路径白名单与扫描语义
// 照抄」actions.ts，故保留裸前缀语义（含 `/optx` 这类误放行形状，测试已钉住）。
func isPathAllowed(path string) bool {
	resolved := resolvePath(path)
	for _, baseDir := range allowedBaseDirs() {
		if strings.HasPrefix(resolved, baseDir) {
			return true
		}
	}
	return false
}

// resolvePath 复刻 Node 的 path.resolve(path)：绝对路径规范化，相对路径拼到
// 当前工作目录。本路由的输入都已由 expandInputPath 规范化为绝对路径，这里只是
// 防卫性对齐。
func resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	if cwd, err := os.Getwd(); err == nil {
		return filepath.Join(cwd, path)
	}
	return filepath.Clean(path)
}

// expandInputPath 复刻 src/lib/collect/paths.ts：
//
//   - `~` / `~/x` → $HOME（不支持 ~user）
//   - 相对路径 → 解析到 $HOME 下
//   - 绝对路径 → 原样
//
// 返回值经 resolve 规范化，但保留用户输入的结尾斜杠（scan-path 之类调用方用它
// 区分「列出该目录内容」；本域只是照抄语义，避免两条路由对同一输入解释不同）。
func expandInputPath(input string) string {
	home := homeDir()
	trimmed := jsstr.Trim(input)

	var expanded string
	switch {
	case trimmed == "~":
		expanded = home
	case strings.HasPrefix(trimmed, "~/"):
		expanded = resolveFrom(home, trimmed[2:])
	case filepath.IsAbs(trimmed):
		expanded = filepath.Clean(trimmed)
	default:
		expanded = resolveFrom(home, trimmed)
	}

	if strings.HasSuffix(trimmed, "/") && expanded != "/" {
		return expanded + "/"
	}
	return expanded
}

// resolveFrom 复刻 path.resolve(base, rest)：rest 为绝对路径时赢过 base
// （Node 的右到左覆盖规则），否则拼到 base 上再规范化。
func resolveFrom(base, rest string) string {
	if filepath.IsAbs(rest) {
		return filepath.Clean(rest)
	}
	return filepath.Join(base, rest)
}
