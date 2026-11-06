package sources

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件复刻 GET /api/collect/sources（列表）与 POST /api/collect/sources（新建）。

// sortableColumns 对应 route.ts 的 SORTABLE_COLUMNS 白名单。
var sortableColumns = map[string]string{
	"name":         "name",
	"type":         "type",
	"projectScope": "project_scope",
	"lastSyncAt":   "last_sync_at",
	"status":       "status",
}

// listHandler 复刻 GET：分页 + type/name/syncStatus/sourceStatus/projectScope 过滤 +
// 白名单排序。响应 `{sources, total, page, pageSize}`，page/pageSize 是 parseInt 的
// 原始结果（NaN 经 JSON.stringify 变成 null）。
func listHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()

		pageF, pageOK := parseIntQuery(query.Get("page"), "1")
		pageSizeF, pageSizeOK := parseIntQuery(query.Get("pageSize"), "20")

		offsetF := (pageF - 1) * pageSizeF

		filter := db.CollectSourcesFilter{}
		if value := query.Get("type"); value != "" {
			filter.Type, filter.TypeSet = value, true
		}
		if value := query.Get("name"); value != "" {
			filter.Name, filter.NameSet = value, true
		}
		switch value := query.Get("syncStatus"); value {
		case "success":
			filter.SyncStatus = "success"
		case "failure", "failed":
			filter.SyncStatus = "failed"
		case "never":
			filter.SyncStatus = "never"
		}
		if value := query.Get("sourceStatus"); value == "enabled" || value == "disabled" || value == "unavailable" {
			filter.SourceStatus, filter.SourceStatusSet = value, true
		}
		if value := query.Get("projectScope"); value == "work" || value == "personal" {
			filter.ProjectScope, filter.ScopeSet = value, true
		}

		order := db.CollectSourcesOrder{Asc: query.Get("sortOrder") == "asc"}
		if column, ok := sortableColumns[query.Get("sortBy")]; ok {
			order.Column = column
		}

		pageWindow := db.CollectSourcesPage{}
		if pageSizeOK && pageSizeF >= 0 {
			limit, ok := bindInt64(pageSizeF)
			if !ok {
				// better-sqlite3 把超出 int64 的 LIMIT 绑成 REAL → datatype mismatch → 500。
				logAndError(w, "获取采集源列表失败", "FETCH_ERROR")
				return
			}
			pageWindow.HasLimit, pageWindow.Limit = true, limit
		}
		if pageOK && pageSizeOK && !math.IsNaN(offsetF) && offsetF != 0 {
			offset, ok := bindInt64(offsetF)
			if !ok {
				// 超出 int64 的 OFFSET 同样是 datatype mismatch。
				logAndError(w, "获取采集源列表失败", "FETCH_ERROR")
				return
			}
			pageWindow.HasOffset, pageWindow.Offset = true, offset
		}

		records, err := deps.Queries.ListCollectSourcesPage(r.Context(), filter, order, pageWindow)
		if err != nil {
			logAndError(w, "获取采集源列表失败", "FETCH_ERROR")
			return
		}
		sources := make([]sourceJSON, 0, len(records))
		for _, record := range records {
			item, err := toSourceJSON(record)
			if err != nil {
				logAndError(w, "获取采集源列表失败", "FETCH_ERROR")
				return
			}
			sources = append(sources, item)
		}

		total, err := deps.Queries.CountCollectSources(r.Context(), filter)
		if err != nil {
			logAndError(w, "获取采集源列表失败", "FETCH_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Sources  []sourceJSON `json:"sources"`
			Total    int64        `json:"total"`
			Page     any          `json:"page"`
			PageSize any          `json:"pageSize"`
		}{
			Sources:  sources,
			Total:    total,
			Page:     jsNumberOrNull(pageF),
			PageSize: jsNumberOrNull(pageSizeF),
		})
	}
}

// parseIntQuery 复刻 `parseInt(sp.get(x) || fallback)`：空串/缺省走 fallback；
// 解析失败是 NaN（ok=false）；成功是 double（溢出时按 JS 的 double 结果返回，
// 超出 int64 的 LIMIT/OFFSET 会在 bindInt64 处被判成不可绑定）。
func parseIntQuery(raw, fallback string) (float64, bool) {
	if raw == "" {
		raw = fallback
	}
	return parseJSIntDouble(raw)
}

// bindInt64 复刻 better-sqlite3 对 LIMIT/OFFSET 的参数绑定：只有落在 int64 内的
// 整数值才能绑定成功（REAL 值会触发 SQLite 的 datatype mismatch）。
func bindInt64(value float64) (int64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
		return 0, false
	}
	const maxInt64AsFloat = 9223372036854775807
	if value >= 9223372036854775808.0 || value < -9223372036854775808.0 {
		return 0, false
	}
	return int64(value), true
}

// jsNumberOrNull 复刻 JSON.stringify(number)：NaN / ±Infinity 输出 null。
// 数值本身按 JS 的 Number#toString 形态输出（1e21 起才用指数形式），避免 Go 在
// 1e6 这类量级上提前切成 1e+06。
func jsNumberOrNull(value float64) any {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return json.RawMessage("null")
	}
	absolute := math.Abs(value)
	if value == math.Trunc(value) && absolute < 1e21 {
		return json.RawMessage(strconv.FormatFloat(value, 'f', -1, 64))
	}
	return json.RawMessage(strconv.FormatFloat(value, 'g', -1, 64))
}

// createHandler 复刻 POST：zod 校验 → 别名唯一性 → 状态推导 → 插入 → 201。
func createHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSONBody(r)
		if err != nil {
			logAndError(w, "创建采集源失败", "CREATE_ERROR")
			return
		}

		input, issues := validateCollectSource(body)
		if len(issues) > 0 {
			respondValidation(w, issues)
			return
		}

		// route.ts 只在 body 带了非空 aliases 时才读全表查重。
		if len(input.Aliases) > 0 {
			aliases, err := existingAliases(r, deps.Queries, -1)
			if err != nil {
				logAndError(w, "创建采集源失败", "CREATE_ERROR")
				return
			}
			if duplicates := duplicateAliases(input.Aliases, aliases); len(duplicates) > 0 {
				respond.Error(w, http.StatusBadRequest, "别名已被使用: "+joinAliases(duplicates), "DUPLICATE_ALIAS")
				return
			}
		}

		now := currentUnix()
		status := sourceStatusFromConfig(input.Config.AuthorEmails, input.Enabled)
		configJSON, err := marshalCreateConfig(input)
		if err != nil {
			logAndError(w, "创建采集源失败", "CREATE_ERROR")
			return
		}
		enabled := input.Enabled == nil || *input.Enabled

		record, err := deps.Queries.InsertCollectSource(r.Context(), db.CollectSourceWrite{
			Type:         input.Type,
			Name:         input.Name,
			Config:       configJSON,
			Enabled:      boolPointer(enabled),
			Status:       &status,
			ProjectScope: input.ProjectScope,
			UpdatedAt:    now,
		}, now)
		if err != nil {
			logAndError(w, "创建采集源失败", "CREATE_ERROR")
			return
		}

		item, err := toSourceJSON(record)
		if err != nil {
			logAndError(w, "创建采集源失败", "CREATE_ERROR")
			return
		}
		respond.JSON(w, http.StatusCreated, item)
	}
}

// marshalCreateConfig 复刻 POST 的 normalizedConfig：
//
//	{...validated.config,
//	 branchCursors: validated.config.branchCursors?.map(c => ({name, lastCommitTime: c.lastCommitTime ?? null})),
//	 ...(validated.aliases?.length ? {aliases: validated.aliases} : {})}
func marshalCreateConfig(input collectSourceInput) (string, error) {
	config := newOrderedObject()
	setOptionalString(config, "baseUrl", input.Config.BaseURL)
	setRawString(config, "owner", input.Config.Owner)
	setOptionalString(config, "repo", input.Config.Repo)
	setOptionalString(config, "token", input.Config.Token)
	setStringArray(config, "authorEmails", input.Config.AuthorEmails)
	if input.Config.HasBranches {
		setBranches(config, "branches", input.Config.Branches)
	}
	if input.Config.HasBranchCursors {
		setNormalizedBranches(config, "branchCursors", input.Config.BranchCursors)
	}
	if len(input.Aliases) > 0 {
		setStringArray(config, "aliases", input.Aliases)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func boolPointer(value bool) *int64 {
	var encoded int64
	if value {
		encoded = 1
	}
	return &encoded
}

func sourceStatusFromConfig(authorEmails []string, enabled *bool) string {
	if len(authorEmails) == 0 {
		return "unavailable"
	}
	if enabled != nil && !*enabled {
		return "disabled"
	}
	return "enabled"
}

// respondValidation 复刻 zod 失败的 400：{error:'数据验证失败', code:'VALIDATION_ERROR', details:{issues}}。
func respondValidation(w http.ResponseWriter, issues []issue) {
	respond.JSON(w, http.StatusBadRequest, struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details struct {
			Issues []issue `json:"issues"`
		} `json:"details"`
	}{
		Error: "数据验证失败",
		Code:  "VALIDATION_ERROR",
		Details: struct {
			Issues []issue `json:"issues"`
		}{Issues: issues},
	})
}

// existingAliases 读出所有采集源的 config.aliases（route.ts 的
// `allSources.flatMap(s => (s.config.aliases as string[]) || [])`）。
// excludeID >= 0 时跳过该行（PUT 的「忽略自己」）。
func existingAliases(r *http.Request, queries *db.Queries, excludeID int64) (map[string]struct{}, error) {
	records, err := queries.ListCollectSources(r.Context())
	if err != nil {
		return nil, err
	}
	aliases := map[string]struct{}{}
	for _, record := range records {
		if excludeID >= 0 && record.ID == excludeID {
			continue
		}
		var config map[string]any
		if len(record.Config) > 0 {
			var parsed any
			if err := json.Unmarshal(record.Config, &parsed); err != nil {
				return nil, err
			}
			if parsed == nil {
				// `s.config.aliases` 在 JSON null 上抛 TypeError → route.ts 的 catch 500。
				return nil, errors.New("collect sources: config is null")
			}
			config, _ = parsed.(map[string]any)
		}
		switch values := config["aliases"].(type) {
		case []any:
			for _, value := range values {
				if text, ok := value.(string); ok {
					aliases[text] = struct{}{}
				}
			}
		case string:
			// `flatMap(s => (s.config.aliases as string[]) || [])` 对字符串返回
			// 字符串本身（flatMap 只摊平数组），所以整串算一个别名。
			aliases[values] = struct{}{}
		}
	}
	return aliases, nil
}

// duplicateAliases 复刻 `validated.aliases.filter(a => existingAliases.has(a))`：
// 保持输入顺序。
func duplicateAliases(candidates []string, existing map[string]struct{}) []string {
	var duplicates []string
	for _, candidate := range candidates {
		if _, ok := existing[candidate]; ok {
			duplicates = append(duplicates, candidate)
		}
	}
	return duplicates
}

// joinAliases 复刻 JS 的 `duplicates.join(', ')`。
func joinAliases(values []string) string {
	result := ""
	for i, value := range values {
		if i > 0 {
			result += ", "
		}
		result += value
	}
	return result
}
