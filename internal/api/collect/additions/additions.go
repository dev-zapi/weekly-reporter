// Package additions 承载 B4 唯一的 additive 变更：collect 的两个 `'use server'`
// action 变为 POST 路由，1:1 镜像 src/app/collect/actions.ts
// （blueprint §2.8 / §5 B4、ADR-0030）。
//
// 返回形状照现状：业务结果一律 200，错误放在响应对象的内嵌 error 字段；
// HTTP 层错误只来自 withAuth/audit。两条路由在 SPA 批（B7）之前没有 UI 消费者，
// 只以 httptest/curl 验收。
//
// 为什么单独成包而不是并入 internal/api/collect：#103（sources CRUD）与 #117
// （git 执行面）在同批并行施工、都落在 /api/collect 前缀下；独立子包让三张票的
// 符号互不冲突，路由仍在 internal/api/router.go 扁平挂载、与兄弟路由共存。
package additions

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把两条增补路由注册到 /api 子路由上。
func Mount(r chi.Router, deps Deps) {
	r.Post("/collect/scan-repos", scanReposHandler(deps))
	r.Post("/collect/batch-add-sources", batchAddSourcesHandler(deps))
}

// actions.ts 里 catch 分支的兜底文案（`error instanceof Error ? error.message :
// '扫描失败'/'批量添加失败'`）。
const (
	scanFallbackError  = "扫描失败"
	batchFallbackError = "批量添加失败"
	// scanRepos 的默认参数 `maxDepth: number = 3`。
	defaultMaxDepth = 3.0
)

// foundRepo 是 scanRepos 返回的 {path, name, alreadyAdded}。
type foundRepo struct {
	Path         string `json:"path"`
	Name         string `json:"name"`
	AlreadyAdded bool   `json:"alreadyAdded"`
}

// scanReposResponse 是 {repos, error?}：成功时没有 error 键。
type scanReposResponse struct {
	Repos []foundRepo `json:"repos"`
	Error string      `json:"error,omitempty"`
}

// scanReposHandler 复刻 actions.ts 的 scanRepos(basePath, maxDepth = 3)。
func scanReposHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSON(r)
		if err != nil {
			// 请求体不可解析：actions.ts 里等价于 expandInputPath 之前的参数
			// 异常，整条逻辑落进 catch → 200 + 内嵌 error。
			log.Printf("collect scan-repos: decode body: %v", err)
			writeScanReposError(w, err.Error())
			return
		}

		object, ok := body.(map[string]any)
		if !ok {
			writeScanReposError(w, scanFallbackError)
			return
		}
		basePath, ok := object["basePath"].(string)
		if !ok {
			// actions.ts 的签名要求 string；非字符串在 `input.trim()` 处抛
			// TypeError → catch（200 + 内嵌 error）。
			writeScanReposError(w, scanFallbackError)
			return
		}
		maxDepth, ok := maxDepthValue(object)
		if !ok {
			writeScanReposError(w, scanFallbackError)
			return
		}

		resolvedPath := expandInputPath(basePath)
		if !isPathAllowed(resolvedPath) {
			writeScanReposError(w, "不允许访问此目录")
			return
		}
		if !exists(resolvedPath) {
			writeScanReposError(w, "目录不存在")
			return
		}

		owners, err := deps.Queries.ListGitLocalCollectSourceOwners(r.Context())
		if err != nil {
			log.Printf("collect scan-repos: list sources: %v", err)
			writeScanReposError(w, err.Error())
			return
		}
		known := make(map[string]struct{}, len(owners))
		for _, owner := range owners {
			known[owner] = struct{}{}
		}

		found := scanForGitRepos(resolvedPath, maxDepth)
		repos := make([]foundRepo, 0, len(found))
		for _, path := range found {
			_, alreadyAdded := known[path]
			repos = append(repos, foundRepo{
				Path:         path,
				Name:         filepath.Base(path),
				AlreadyAdded: alreadyAdded,
			})
		}

		respond.JSON(w, http.StatusOK, scanReposResponse{Repos: repos})
	}
}

func writeScanReposError(w http.ResponseWriter, message string) {
	respond.JSON(w, http.StatusOK, scanReposResponse{Repos: []foundRepo{}, Error: message})
}

// maxDepthValue 复刻 `maxDepth: number = 3` 的 JS 语义：
//   - 键缺省 → 默认参数 3；
//   - 显式 null → 不触发默认参数，参与 `currentDepth > maxDepth` 数值比较时
//     null 折算为 0（即只扫容器本身，结果为空）；
//   - 数字原样（小数也照 `>` 比较）。
//
// 本路由的请求体是新增的 HTTP 面（TS 侧是强类型 server action，参数类型由调用方
// 保证），其它类型按非法请求走内嵌 error，不做 JS 的隐式字符串数值转换。
func maxDepthValue(object map[string]any) (float64, bool) {
	raw, present := object["maxDepth"]
	if !present {
		return defaultMaxDepth, true
	}
	switch value := raw.(type) {
	case nil:
		return 0, true
	case float64:
		return value, true
	default:
		return 0, false
	}
}

// batchAddResponse 是 {success, addedCount, error?}：成功时没有 error 键。
type batchAddResponse struct {
	Success    bool   `json:"success"`
	AddedCount int64  `json:"addedCount"`
	Error      string `json:"error,omitempty"`
}

// gitLocalConfig 是落库 config 的 JSON 形状，键顺序照 actions.ts 的对象字面量
// （owner, authorEmails, branches）。
//
// authorEmails 用 json.RawMessage：TS 是 JSON.parse(body) 后再 JSON.stringify，
// 所以这里同样「解析后原样重序列化」——缺省（undefined）时键被省略，显式 null
// 保留为 null，数组（含空数组）原样写出。
type gitLocalConfig struct {
	Owner        string          `json:"owner"`
	AuthorEmails json.RawMessage `json:"authorEmails,omitempty"`
	Branches     []string        `json:"branches"`
}

// batchAddSourcesHandler 复刻 actions.ts 的 batchAddSources(repos)。
//
// 与 TS 一样**不开事务**：逐行插入，某行失败时之前插入的行保留，响应固定
// addedCount:0 + error（部分失败的形状由票面测试钉住）。
// 与 TS 一样**不做白名单校验**：白名单只属于 scanRepos；本 action 只去重并插入。
func batchAddSourcesHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSON(r)
		if err != nil {
			log.Printf("collect batch-add-sources: decode body: %v", err)
			writeBatchAddError(w, err.Error())
			return
		}

		object, ok := body.(map[string]any)
		if !ok {
			writeBatchAddError(w, batchFallbackError)
			return
		}
		rawRepos, ok := object["repos"].([]any)
		if !ok {
			// TS: `for (const repo of repos)` 对 undefined/null/标量抛 TypeError → catch。
			writeBatchAddError(w, batchFallbackError)
			return
		}

		owners, err := deps.Queries.ListGitLocalCollectSourceOwners(r.Context())
		if err != nil {
			log.Printf("collect batch-add-sources: list sources: %v", err)
			writeBatchAddError(w, err.Error())
			return
		}
		known := make(map[string]struct{}, len(owners))
		for _, owner := range owners {
			known[owner] = struct{}{}
		}

		// actions.ts: `const now = new Date()`，drizzle 的 timestamp mode 写 Unix 秒。
		now := time.Now().Unix()
		var addedCount int64

		for _, raw := range rawRepos {
			repo, ok := raw.(map[string]any)
			if !ok {
				writeBatchAddError(w, batchFallbackError)
				return
			}
			path, ok := repo["path"].(string)
			if !ok {
				writeBatchAddError(w, batchFallbackError)
				return
			}
			// 先做去重再读 name：TS 的 `continue` 在插入之前，已存在的条目即使
			// 其它字段缺失也不会触发错误。
			if _, exists := known[path]; exists {
				continue
			}
			name, ok := repo["name"].(string)
			if !ok {
				// drizzle 会因 NOT NULL / undefined 绑定抛错 → catch。
				writeBatchAddError(w, batchFallbackError)
				return
			}

			config := gitLocalConfig{Owner: path, Branches: []string{}}
			if rawAuthorEmails, present := repo["authorEmails"]; present {
				encoded, err := json.Marshal(rawAuthorEmails)
				if err != nil {
					writeBatchAddError(w, err.Error())
					return
				}
				config.AuthorEmails = encoded
			}
			encodedConfig, err := json.Marshal(config)
			if err != nil {
				writeBatchAddError(w, err.Error())
				return
			}

			err = deps.Queries.InsertGitLocalCollectSource(r.Context(), db.InsertGitLocalCollectSourceParams{
				Name:      name,
				Config:    string(encodedConfig),
				Enabled:   1,
				CreatedAt: now,
				UpdatedAt: now,
			})
			if err != nil {
				log.Printf("collect batch-add-sources: insert source: %v", err)
				writeBatchAddError(w, err.Error())
				return
			}

			known[path] = struct{}{}
			addedCount++
		}

		respond.JSON(w, http.StatusOK, batchAddResponse{Success: true, AddedCount: addedCount})
	}
}

func writeBatchAddError(w http.ResponseWriter, message string) {
	respond.JSON(w, http.StatusOK, batchAddResponse{Success: false, AddedCount: 0, Error: message})
}

// decodeJSON 复刻 `await request.json()`：读整个 body 再解析。
// json.Unmarshal 与 JSON.parse 一样拒绝尾随垃圾，数字折成 float64。
func decodeJSON(r *http.Request) (any, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}
