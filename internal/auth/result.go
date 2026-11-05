package auth

import "context"

// Mode 是本次请求的认证方式，逐值对应 src/lib/auth/types.ts 的 AuthMode。
// handler 需要它来决定响应内容（/api/auth/verify 的 mode 字段），所以必须从
// 中间件传到 handler，而不是让 handler 再判定一次——再判定一次会重复 DB 查询 /
// 重复 touchPat，还可能写出与审计行不一致的结论（route.ts 的注释即此意）。
type Mode string

const (
	ModeDisabled Mode = "disabled"
	ModePassword Mode = "password"
	ModePAT      Mode = "pat"
)

// Result 是中间件对本次请求的判定结果。只有鉴权通过才会出现在 context 里；
// PATName 仅在 ModePAT 下非空（密码模式与认不出 PAT 的失败都是 nil）。
type Result struct {
	Mode    Mode
	PATName *string
}

type resultContextKey struct{}

func withResult(ctx context.Context, res Result) context.Context {
	return context.WithValue(ctx, resultContextKey{}, res)
}

// ResultFromContext 读取中间件的判定结果。请求未经过 Middleware 时返回 false，
// 调用方必须 fail closed（顶层路由已经由 Middleware 全覆盖，这是纵深防御）。
func ResultFromContext(ctx context.Context) (Result, bool) {
	res, ok := ctx.Value(resultContextKey{}).(Result)
	return res, ok
}
