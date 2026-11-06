package sources

import (
	"strings"
)

// 本文件移植 src/lib/collect/paths.ts 与 realpath.ts 里只属于采集源数据面的部分。
// 路径展开（expandInputPath / path.resolve）已收口到 internal/api/collect/collectpath，
// 三条 B4 路由族共用同一实现；这里只留 stripTrailingSlash 与 realpath 包装。

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
