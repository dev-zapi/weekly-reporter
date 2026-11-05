// Package web 内嵌 SPA 构建产物（ADR-0025）。
//
// embed 无法引用父目录，而 vite 产物固定在仓根 web/dist，所以内嵌包只能放在
// web/ 这一层。B0 阶段 dist 里只有一个占位 index.html —— SPA 是 B7 的事，
// 本票不引入任何 vite 依赖，只保证 `fresh clone + make build` 可复现。
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
