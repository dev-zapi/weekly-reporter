// Package buildinfo 持有构建期注入的版本信息（ADR-0025 的 -ldflags 轨道）。
//
// 两个变量都是包级 string，由 `go build -ldflags "-X ...buildinfo.CommitHash=... -X
// ...buildinfo.BuildTime=..."` 覆写；未注入时（go run / go test）保留 dev 默认值。
// 之所以用裸 string 而不是 struct：-X 只能写包级 string 变量。
package buildinfo

var (
	// CommitHash 是构建时的 git commit（短哈希即可，由 Makefile 决定）。
	CommitHash = "dev"
	// BuildTime 是构建时刻，RFC3339 格式。
	BuildTime = "dev"
)

// Info 是 health 路由对外暴露的构建信息。
type Info struct {
	CommitHash string `json:"commitHash"`
	BuildTime  string `json:"buildTime"`
}

// Current 返回当前二进制的构建信息。
func Current() Info {
	return Info{CommitHash: CommitHash, BuildTime: BuildTime}
}
