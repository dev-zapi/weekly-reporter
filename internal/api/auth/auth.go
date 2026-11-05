// Package auth 把认证域路由（`/api/auth/**`）挂到 chi 的 /api 子路由上。
// 行为逐条对照 src/app/api/auth/**/route.ts；鉴权、审计与 trace 响应头由中间件
// 负责（internal/auth 与 internal/trace），所以这些 handler 不再重复鉴权。
package auth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
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

		expiresAtMillis, ok := optionalMillis(object, isObject)
		if !ok {
			// route.ts 的 createPat 抛错分支（布尔 / 对象 / 多元素数组无法绑定）。
			log.Printf("Error creating PAT: unusable expiresAt in body")
			respond.Error(w, http.StatusInternalServerError, "Failed to create PAT", "CREATE_ERROR")
			return
		}

		created, err := auth.CreatePAT(r.Context(), deps.Queries, name, expiresAtMillis)
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

// optionalMillis 复刻 route.ts 的 `createPat(db, name.trim(), { expiresAt })`。
// ok=false 表示 route.ts 会抛错并回 500 CREATE_ERROR；其余一律 201。
//
// expiresAt 在 TS 里是原样绑定进 drizzle 的，两条可观测后果必须一起对上：
//
//	鉴权判定：guard 用 `expiresAt <= now` 比较。JS 的关系比较会把字符串转数字，
//	          所以 "42" 过期、"later" 永不过期（与数字比较恒为 false）、"Infinity"
//	          永不过期、"-Infinity" 立刻过期。这里用 jsToNumber 复刻该转换，
//	          而不是「凡非 number 一律永不过期」。
//	绑定成败：better-sqlite3 只接受数字 / 字符串 / bigint / Buffer / null，布尔与
//	          对象在绑定阶段抛错（→ 500），数组按参数列表展开（单元素才成功）。
//
// 仍有一处存储类差异（本票无法消除，见下）：sqlc 把 expires_at 生成为 *int64，
// 表达不了 TS 会让 INTEGER 亲和列留下的 TEXT（"later"）与 REAL（1.5）；要逐字节
// 对等得改跨批次的列类型契约，而蓝图 §2.5 冻结 schema、票面又写明「只施工不设计」。
// 对鉴权结论无影响：TEXT 值在 JS 里比较恒为 false，与这里记 NULL 同义；REAL 小数
// 与截断后的整数在「是否已过期」上同结论。
func optionalMillis(object map[string]any, isObject bool) (*int64, bool) {
	if !isObject {
		return nil, true
	}
	value, present := object["expiresAt"]
	if !present || value == nil {
		return nil, true
	}
	return expiresAtMillis(value)
}

// expiresAtMillis 把一个 JSON 值折成库里的 INTEGER 时间戳；ok=false 对应 TS 的 500。
func expiresAtMillis(value any) (*int64, bool) {
	if value == nil {
		return nil, true
	}
	switch v := value.(type) {
	case float64:
		return millisFromDouble(v), true
	case string:
		number, kind := jsToNumber(v)
		switch kind {
		case jsNumberNegInfinity:
			return int64Ptr(math.MinInt64), true
		case jsNumberNaN, jsNumberPosInfinity:
			// JS 里与数字比较恒为 false → 永不过期。
			return nil, true
		default:
			return millisFromDouble(number), true
		}
	case []any:
		// better-sqlite3 把数组展开成参数列表：长度 1 才绑定成功，其余抛错。
		if len(v) != 1 {
			return nil, false
		}
		return expiresAtMillis(v[0])
	default:
		// 布尔 / 对象：绑定阶段抛错 → route.ts 的 catch → 500 CREATE_ERROR。
		return nil, false
	}
}

// millisFromDouble 把 JS 数字折成 int64。越界必须夹到两端：Go 的 float→int 转换
// 在溢出时给出 MinInt64，会让 1e300 立刻过期，而 TS 的 `1e300 <= now` 为 false。
func millisFromDouble(number float64) *int64 {
	switch {
	case math.IsNaN(number):
		return nil
	case number >= math.MaxInt64:
		return int64Ptr(math.MaxInt64)
	case number <= math.MinInt64:
		return int64Ptr(math.MinInt64)
	default:
		return int64Ptr(int64(number))
	}
}

func int64Ptr(v int64) *int64 { return &v }

type jsNumberKind int

const (
	jsNumberFinite jsNumberKind = iota
	jsNumberNaN
	jsNumberPosInfinity
	jsNumberNegInfinity
)

// jsToNumber 复刻 ECMAScript 的 ToNumber(字符串)：裁掉首尾空白、空串为 0、
// 支持 ±Infinity 与 0x/0o/0b 字面量、十进制与指数写法；其余为 NaN。
//
// 不用 strconv.ParseFloat 直接兜底：Go 还接受 "inf" / "nan" 这类 JS 视为 NaN 的
// 写法，会把「永不过期」错判成「立刻过期」。所以先按 JS 文法校验再解析。
func jsToNumber(s string) (float64, jsNumberKind) {
	s = strings.TrimSpace(s)
	switch s {
	case "":
		return 0, jsNumberFinite
	case "Infinity", "+Infinity":
		return 0, jsNumberPosInfinity
	case "-Infinity":
		return 0, jsNumberNegInfinity
	}

	for _, prefix := range []struct {
		token string
		base  float64
	}{
		{"0x", 16}, {"0X", 16},
		{"0o", 8}, {"0O", 8},
		{"0b", 2}, {"0B", 2},
	} {
		if !strings.HasPrefix(s, prefix.token) {
			continue
		}
		// JS 不允许带符号的进制前缀（Number("-0x10") 是 NaN）。
		digits := s[len(prefix.token):]
		if digits == "" {
			return 0, jsNumberNaN
		}
		var n float64
		for i := 0; i < len(digits); i++ {
			d, ok := radixDigit(prefix.base, digits[i])
			if !ok {
				return 0, jsNumberNaN
			}
			n = n*prefix.base + d
		}
		return n, jsNumberFinite
	}

	if !isJSDecimal(s) {
		return 0, jsNumberNaN
	}
	number, err := strconv.ParseFloat(s, 64)
	if err != nil {
		if errors.Is(err, strconv.ErrRange) {
			// 上溢到 ±Inf、下溢到 0：两个方向都与 JS 一致。
			if strings.HasPrefix(s, "-") {
				return 0, jsNumberNegInfinity
			}
			return 0, jsNumberPosInfinity
		}
		return 0, jsNumberNaN
	}
	return number, jsNumberFinite
}

// isJSDecimal 判断是否符合 JS 的十进制数字文法：
//
//	[+-]? ( digits [ '.' digits? ] | '.' digits ) [ ('e'|'E') [+-]? digits ]
func isJSDecimal(s string) bool {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	intDigits := 0
	for i < len(s) && isASCIIDigit(s[i]) {
		i++
		intDigits++
	}
	fracDigits := 0
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && isASCIIDigit(s[i]) {
			i++
			fracDigits++
		}
	}
	if intDigits == 0 && fracDigits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		expDigits := 0
		for i < len(s) && isASCIIDigit(s[i]) {
			i++
			expDigits++
		}
		if expDigits == 0 {
			return false
		}
	}
	return i == len(s)
}

func isASCIIDigit(b byte) bool { return b >= '0' && b <= '9' }

func radixDigit(base float64, b byte) (float64, bool) {
	switch {
	case b >= '0' && b <= '9':
		return float64(b - '0'), true
	case base == 16 && b >= 'a' && b <= 'f':
		return float64(b-'a') + 10, true
	case base == 16 && b >= 'A' && b <= 'F':
		return float64(b-'A') + 10, true
	}
	return 0, false
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
