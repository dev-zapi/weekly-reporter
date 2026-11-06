package sources

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sort"

	"github.com/dev-zapi/weekly-reporter/internal/api/collect/collectpath"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// jsTrim 复刻 String.prototype.trim()（ECMAScript 空白集合）。
func jsTrim(value string) string { return jsstr.Trim(value) }

// evalSymlinks 是 realpath(3) 的 Go 版；测试可替换（lookup 用）。
var evalSymlinks = filepath.EvalSymlinks

// lookupHandler 复刻 GET /api/collect/sources/lookup：
// git-local 来源按 config.owner（规范化后的本地绝对路径）匹配，
// 匹配优先级：精确字符串 → realpath 等价（仅当两侧都能在磁盘上解析）。
func lookupHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		rawType := query.Get("type")
		rawPath := query.Get("path")

		if rawType != "git-local" {
			respond.Error(w, http.StatusBadRequest, "仅支持本地 Git 来源", "INVALID_TYPE")
			return
		}
		if rawPath == "" || jsTrim(rawPath) == "" {
			respond.Error(w, http.StatusBadRequest, "path is required", "INVALID_PATH")
			return
		}

		normalizedPath := stripTrailingSlash(collectpath.ExpandInputPath(rawPath))
		candidateRealpath := tryRealpath(normalizedPath)

		rows, err := deps.Queries.ListCollectSourcesByType(r.Context(), "git-local")
		if err != nil {
			logAndError(w, "查询采集源失败", "LOOKUP_ERROR")
			return
		}
		type localSource struct {
			record db.CollectSourceRecord
			owner  string
		}
		sources := make([]localSource, 0, len(rows))
		for _, row := range rows {
			record := row.Record()
			// drizzle 的 json mode 在 findMany 时解析 config；非法 JSON → 500。
			owner, err := configOwner(record.Config)
			if err != nil {
				logAndError(w, "查询采集源失败", "LOOKUP_ERROR")
				return
			}
			sources = append(sources, localSource{record: record, owner: owner})
		}
		// `[...localSources].sort((a, b) => a.id - b.id)`：升序，最早的 id 优先。
		sort.SliceStable(sources, func(i, j int) bool { return sources[i].record.ID < sources[j].record.ID })

		for _, source := range sources {
			if source.owner == normalizedPath {
				writeLookupHit(w, source.record)
				return
			}
		}

		if candidateRealpath != nil {
			for _, source := range sources {
				if source.owner == "" {
					continue
				}
				ownerRealpath := tryRealpath(source.owner)
				if ownerRealpath != nil && *ownerRealpath == *candidateRealpath {
					writeLookupHit(w, source.record)
					return
				}
			}
		}

		respond.Error(w, http.StatusNotFound, "采集源不存在", "NOT_FOUND")
	}
}

// configOwner 复刻 `(source.config?.owner as string | undefined) || ”`。
// 非法 JSON 返回 error（drizzle 的 json mode 在解析时抛错 → 500）。
func configOwner(raw []byte) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", err
	}
	config, _ := parsed.(map[string]any)
	owner, _ := config["owner"].(string)
	return owner, nil
}

func writeLookupHit(w http.ResponseWriter, record db.CollectSourceRecord) {
	item, err := toSourceJSON(record)
	if err != nil {
		logAndError(w, "查询采集源失败", "LOOKUP_ERROR")
		return
	}
	respond.JSON(w, http.StatusOK, item)
}
