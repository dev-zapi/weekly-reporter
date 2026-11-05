// Package auth mounts the authentication domain routes (`/api/auth/**`) on the
// chi /api subrouter. Behavior is a 1:1 port of src/app/api/auth/**/route.ts;
// authentication, auditing and trace headers are the middleware's job (internal/auth
// and internal/trace), so these handlers never re-authenticate.
package auth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。收成结构体而不是直接传 *db.Queries：域内测试可以塞
// 真实 sqlc 查询集，也为后续域复用同一装配方式留好形状。
type Deps struct {
	Queries *db.Queries
}

// Mount 把认证域注册到调用方给的 /api 子路由上。
//
// 路由表与 src/app/api/auth 目录一一对应：
//
//	GET    /auth/verify
//	GET    /auth/pats
//	POST   /auth/pats
//	DELETE /auth/pats/{id}
func Mount(r chi.Router, deps Deps) {
	r.Get("/auth/verify", verifyHandler())
	r.Get("/auth/pats", listPATsHandler(deps))
	r.Post("/auth/pats", createPATHandler(deps))
	r.Delete("/auth/pats/{id}", revokePATHandler(deps))
}

// verifyHandler 复刻 src/app/api/auth/verify/route.ts。
//
// 读的是中间件已经解析好的 Result，而不是再跑一次 requireAuth：第二次判定会重复
// DB 查询 / touchPat，并可能与 withAuth 写出的审计行不一致。
func verifyHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result, ok := auth.ResultFromContext(r.Context())
		if !ok {
			// 走不到：中间件只在鉴权成功后调用 handler。保留显式的 fail-closed 分支，
			// 与 route.ts 的 `if (!auth)` 同形，而不是断言请求一定带结果。
			respond.JSON(w, http.StatusUnauthorized, respond.ErrorBody{Error: "Unauthorized"})
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			OK   bool   `json:"ok"`
			Mode string `json:"mode"`
		}{OK: true, Mode: string(result.Mode)})
	}
}

// patMetadata 是列表响应里的单项：不含 token_hash、不含明文。
// 字段名是 drizzle 选择集在 JS 里的属性名（camelCase），不是列名——冻结契约照
// 现有响应形状，客户端按 camelCase 消费。
type patMetadata struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt *int64 `json:"lastUsedAt"`
	ExpiresAt  *int64 `json:"expiresAt"`
	RevokedAt  *int64 `json:"revokedAt"`
}

func listPATsHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := auth.ListPATs(r.Context(), deps.Queries)
		if err != nil {
			log.Printf("Error listing PATs: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to list PATs", "LIST_ERROR")
			return
		}
		// 空列表必须序列化成 [] 而不是 null（前端对 pats.length 做判断）。
		pats := make([]patMetadata, 0, len(rows))
		for _, row := range rows {
			pats = append(pats, patMetadata{
				ID:         row.ID,
				Name:       row.Name,
				Prefix:     row.Prefix,
				CreatedAt:  row.CreatedAt,
				LastUsedAt: row.LastUsedAt,
				ExpiresAt:  row.ExpiresAt,
				RevokedAt:  row.RevokedAt,
			})
		}
		respond.JSON(w, http.StatusOK, struct {
			Pats []patMetadata `json:"pats"`
		}{Pats: pats})
	}
}

// createPATHandler 复刻 POST /api/auth/pats。
//
// body 用 `any` 解析而不是直接解到结构体，是为了保住 route.ts 的 JS 语义：
// `await request.json()` 在 body 不是合法 JSON / 为 `null` 时抛错（→ 500），
// 而对数组 / 字符串 / 数字做解构不抛错、`name` 就是 undefined（→ 400）。
// 直接解到结构体会把这两类输入混成同一个 500。
func createPATHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			log.Printf("Error creating PAT: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create PAT", "CREATE_ERROR")
			return
		}
		var payload any
		if err := json.Unmarshal(raw, &payload); err != nil {
			// 非法 JSON（含空 body）与 TS 的 request.json() 抛错同分支。
			log.Printf("Error creating PAT: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create PAT", "CREATE_ERROR")
			return
		}

		object, isObject := payload.(map[string]any)
		if payload == nil {
			// `const { name } = null` 在 JS 里抛 TypeError → 500 CREATE_ERROR。
			log.Printf("Error creating PAT: body is null")
			respond.Error(w, http.StatusInternalServerError, "Failed to create PAT", "CREATE_ERROR")
			return
		}

		name, ok := parseName(object, isObject)
		if !ok {
			respond.Error(w, http.StatusBadRequest,
				"name is required and must be a non-empty string", "INVALID_NAME")
			return
		}

		created, err := auth.CreatePAT(r.Context(), deps.Queries, name, optionalMillis(object, isObject))
		if err != nil {
			log.Printf("Error creating PAT: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create PAT", "CREATE_ERROR")
			return
		}

		// 明文 token 只在这里返回一次（ADR-0020）。
		respond.JSON(w, http.StatusCreated, struct {
			ID        int64  `json:"id"`
			Name      string `json:"name"`
			Token     string `json:"token"`
			CreatedAt int64  `json:"createdAt"`
		}{ID: created.ID, Name: created.Name, Token: created.Token, CreatedAt: created.CreatedAt})
	}
}

// parseName 复刻 `!name || typeof name !== 'string' || name.trim().length === 0`。
// 非对象 body（数组 / 字符串 / 数字 / 布尔）在 JS 里解构得到 undefined，
// 与「缺 name」同分支 → 400。
func parseName(object map[string]any, isObject bool) (string, bool) {
	if !isObject {
		return "", false
	}
	name, isString := object["name"].(string)
	if !isString {
		// null / 数字 / 对象 / 布尔都等价于 TS 的 typeof 检查失败。
		return "", false
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "", false
	}
	return name, true
}

// optionalMillis 把 body 里的 expiresAt 转成毫秒时间戳；缺省 / null / 非数字一律
// 视为「永不过期」（TS 的 `options.expiresAt ?? null`）。
//
// 小数按 JS 侧存进 INTEGER 亲和列的数值截断（Date.now() 永远给整数，小数只可能
// 来自手写请求）。非数字值在 TS 里会被原样写库、Go 的 int64 无法表达，这里取
// 「不设过期」而不是 500——两者都是垃圾输入，后者更可用。
func optionalMillis(object map[string]any, isObject bool) *int64 {
	if !isObject {
		return nil
	}
	number, ok := object["expiresAt"].(float64)
	if !ok {
		return nil
	}
	millis := int64(number)
	return &millis
}

func revokePATHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// parseInt 而不是 Atoi：`12abc` 在 JS 里是 12（见 jsparse 包注释）。
		id, ok := jsparse.ParseInt(chi.URLParam(r, "id"))
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid PAT ID", "INVALID_ID")
			return
		}

		ctx := r.Context()
		if _, err := deps.Queries.FindAPITokenByID(ctx, id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				respond.Error(w, http.StatusNotFound, "PAT not found", "NOT_FOUND")
				return
			}
			log.Printf("Error revoking PAT: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to revoke PAT", "REVOKE_ERROR")
			return
		}

		// 已吊销的再吊一次也是 204：revoke 是幂等的（条件带 revoked_at IS NULL）。
		if _, err := auth.RevokePAT(ctx, deps.Queries, id); err != nil {
			log.Printf("Error revoking PAT: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to revoke PAT", "REVOKE_ERROR")
			return
		}

		// NextResponse(null, { status: 204 })：无 body、无 content-type。
		w.WriteHeader(http.StatusNoContent)
	}
}
