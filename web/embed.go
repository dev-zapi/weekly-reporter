// Package web 内嵌 SPA 构建产物（ADR-0025）。
//
// embed 无法引用父目录，而 vite 产物固定在仓根 web/dist，所以内嵌包只能放在
// web/ 这一层。B7 起 dist 由 `pnpm -C web build` 产出（`make build` 的 web 目标）；
// 目录里保留 .gitkeep，让 fresh clone 上的 `//go:embed all:dist` 也能编译。
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// Dist 返回 web/dist 子树；调用方（SPA handler、静态资源）都以它为根。
func Dist() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}

// Handler 服务 SPA 产物：命中文件直出，未命中且无扩展名时回落到 index.html
// （客户端路由），带扩展名的缺失资源必须 404 —— 否则前端会把 404 的 JS 当 HTML 解析。
func Handler() (http.Handler, error) {
	sub, err := Dist()
	if err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." {
			name = "index.html"
		}
		if _, err := fs.Stat(sub, name); err != nil {
			if strings.Contains(path.Base(name), ".") {
				http.NotFound(w, r)
				return
			}
			clone := r.Clone(r.Context())
			clone.URL.Path = "/"
			fileServer.ServeHTTP(w, clone)
			return
		}
		fileServer.ServeHTTP(w, r)
	}), nil
}
