package additions

import (
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/collect/collectpath"
)

// 本文件提供两条增补路由需要的路径语义。路径展开（expandInputPath / path.resolve）
// 收口在 internal/api/collect/collectpath；这里只保留 actions.ts 的白名单判定。

// allowedBaseDirs 复刻 actions.ts 的 ALLOWED_BASE_DIRS：
//
//	[process.env.HOME || '/home', '/opt', '/srv', '/var', '/tmp']
//
// 与 scan-path route.ts 那个 Set（显式含 '/home'、HOME 未设置时不加）不同：
// actions.ts 是数组且 HOME 缺省时回落 '/home'，本票以 actions.ts 为唯一事实源。
func allowedBaseDirs() []string {
	dirs := make([]string, 0, 5)
	dirs = append(dirs, collectpath.HomeDir())
	return append(dirs, collectpath.StandardBaseDirs...)
}

// isPathAllowed 复刻 actions.ts 的 isPathAllowed：path.resolve 之后做裸前缀比较。
//
// TS 事实源：src/app/collect/actions.ts。注意这里是 `startsWith(baseDir)`，不是
// scan-path route 的 `=== baseDir || startsWith(baseDir + '/')`——票面要求「路径
// 白名单与扫描语义照抄」actions.ts，故保留裸前缀语义（含 `/optx` 这类误放行形状，
// 测试已钉住）。collect 包里的同名函数有意不同，不要合并。
func isPathAllowed(path string) bool {
	resolved := collectpath.Resolve(path)
	for _, baseDir := range allowedBaseDirs() {
		if strings.HasPrefix(resolved, baseDir) {
			return true
		}
	}
	return false
}
