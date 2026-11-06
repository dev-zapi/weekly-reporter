package collect

import (
	"os"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/collect/collectpath"
)

// 本文件是 src/lib/collect/paths.ts 与 scan-path/route.ts 里路径语义的 Go 对应物：
// 路径展开（CONTEXT.md「路径展开」）与目录白名单（蓝图 §5 B4）。
//
// 路径展开的实现收口在 collectpath（B4 三张票曾各自带一份私有拷贝）；
// 白名单判定留在本包，因为 scan-path/route.ts 的语义（按 `/` 分段比较）与
// actions.ts（裸前缀）确有差异，两个判定函数必须各自显式、各自注明事实源。

// allowedBaseDirs 复刻 scan-path/route.ts 的 ALLOWED_BASE_DIRS：
// $HOME、/home、/opt、/srv、/var、/tmp。HOME 未设置时该条目不参与。
func allowedBaseDirs() []string {
	dirs := make([]string, 0, 6)
	if home := os.Getenv("HOME"); home != "" {
		dirs = append(dirs, home)
	}
	// scan-path route 的 Set 显式含 '/home'（HOME 恰好是 /home 时由 Set 去重）。
	dirs = append(dirs, "/home")
	return append(dirs, collectpath.StandardBaseDirs...)
}

// isPathAllowed 复刻 scan-path/route.ts 的 isPathAllowed：解析后的路径必须等于
// 某个白名单目录，或位于其下（按 `/` 分段比较，`/various` 不算在 `/var` 下）。
//
// TS 事实源：src/app/api/collect/scan-path/route.ts。与 additions 包那份
// （src/app/collect/actions.ts 的裸前缀比较）有意不同，不要合并。
func isPathAllowed(p string) bool {
	resolved := collectpath.Resolve(p)
	for _, base := range allowedBaseDirs() {
		if resolved == base || strings.HasPrefix(resolved, base+"/") {
			return true
		}
	}
	return false
}
