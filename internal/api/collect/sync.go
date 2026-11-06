package collect

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件是 src/lib/collect/sync.ts 的 Go 对应物（syncSource / syncAllSources /
// insertNewEvents），按票面「行为唯一事实源」逐条移植，包括中文错误文案。

// errSourceBusy 对应 SourceOperationBusyError：同一采集源已有操作在跑时由路由
// 映射成 409 SOURCE_BUSY。
var errSourceBusy = errors.New("source operation busy")

// branchSyncResult 对应 BranchSyncResult。
type branchSyncResult struct {
	Name         string  `json:"name"`
	Status       string  `json:"status"`
	CommitsCount int     `json:"commitsCount"`
	Error        *string `json:"error,omitempty"`
}

// syncResult 对应 SyncResult。字段顺序与 sync.ts 的对象字面量一致，保证响应体
// 键序可对照。warnings 只是类型里的可选字段、sync.ts 从不赋值，因此这里不复制。
type syncResult struct {
	SourceID     int64   `json:"sourceId"`
	SourceName   string  `json:"sourceName"`
	Status       string  `json:"status"`
	CommitsCount int     `json:"commitsCount"`
	EventsCount  int     `json:"eventsCount"`
	Error        *string `json:"error,omitempty"`
	AutoDisabled *bool   `json:"autoDisabled,omitempty"`
	// Branches 只在成功分支出现（含空数组）；失败结果里 sync.ts 的对象字面量
	// 没有这个键，所以用指针 + omitempty 表达。
	Branches *[]branchSyncResult `json:"branches,omitempty"`
}

// localFetchResult 对应 git-local/fetch 的 LocalFetchResult。
type localFetchResult struct {
	SourceID   float64 `json:"sourceId"`
	SourceName string  `json:"sourceName"`
	Status     string  `json:"status"`
	Error      *string `json:"error,omitempty"`
}

func failedResult(sourceID int64, sourceName, message string, autoDisabled *bool) syncResult {
	return syncResult{
		SourceID:     sourceID,
		SourceName:   sourceName,
		Status:       "failed",
		CommitsCount: 0,
		EventsCount:  0,
		Error:        &message,
		AutoDisabled: autoDisabled,
	}
}

// sourceRecord 是 collect_sources 行的内部视图（两条查询的返回列相同）。
type sourceRecord struct {
	ID     int64
	Type   string
	Name   string
	Config sourceConfig
	Status *string
}

func sourceRecordFromGet(row db.GetCollectSourceForExecutionRow) (sourceRecord, error) {
	config, err := parseSourceConfig(row.Config)
	if err != nil {
		return sourceRecord{}, err
	}
	return sourceRecord{ID: row.ID, Type: row.Type, Name: row.Name, Config: config, Status: row.Status}, nil
}

func sourceRecordFromList(row db.ListEnabledCollectSourcesRow) (sourceRecord, error) {
	config, err := parseSourceConfig(row.Config)
	if err != nil {
		return sourceRecord{}, err
	}
	return sourceRecord{ID: row.ID, Type: row.Type, Name: row.Name, Config: config, Status: row.Status}, nil
}

// sourcePatch 收集 UpdateCollectSourceForExecution 的 nullable 参数：nil 表示「本次不改」。
type sourcePatch struct {
	Config         sourceConfig
	Status         *string
	LastSyncAt     *int64
	LastSyncStatus *string
	UpdatedAt      int64
}

func applySourcePatch(ctx context.Context, queries *db.Queries, sourceID int64, patch sourcePatch) error {
	var configText *string
	if patch.Config != nil {
		encoded, err := json.Marshal(patch.Config)
		if err != nil {
			return err
		}
		text := string(encoded)
		configText = &text
	}
	return queries.UpdateCollectSourceForExecution(ctx, db.UpdateCollectSourceForExecutionParams{
		Config:         configText,
		Status:         patch.Status,
		LastSyncAt:     patch.LastSyncAt,
		LastSyncStatus: patch.LastSyncStatus,
		UpdatedAt:      patch.UpdatedAt,
		ID:             sourceID,
	})
}

// syncSource 等价于 syncSource(sourceId, resync)，含每源互斥锁。
func syncSource(ctx context.Context, queries *db.Queries, sourceID int64, resync bool) (syncResult, error) {
	if !acquireSourceOperation(sourceID) {
		return syncResult{}, errSourceBusy
	}
	defer releaseSourceOperation(sourceID)

	return syncSourceUnlocked(ctx, queries, sourceID, resync)
}

// syncSourceUnlocked 是 sync.ts 的相主体。
func syncSourceUnlocked(ctx context.Context, queries *db.Queries, sourceID int64, resync bool) (syncResult, error) {
	row, err := queries.GetCollectSourceForExecution(ctx, sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return failedResult(sourceID, "", "采集源不存在", nil), nil
	}
	if err != nil {
		return syncResult{}, err
	}

	source, err := sourceRecordFromGet(row)
	if err != nil {
		return syncResult{}, err
	}

	if source.Status == nil || *source.Status != "enabled" {
		message := "采集源不可用"
		if source.Status != nil && *source.Status == "disabled" {
			message = "采集源已禁用"
		}
		return failedResult(source.ID, source.Name, message, nil), nil
	}

	// 检查邮箱配置：没有邮箱时标记为不可用。
	if !source.Config.hasAuthorEmail() {
		status := "unavailable"
		now := unixSeconds(time.Now())
		if err := applySourcePatch(ctx, queries, source.ID, sourcePatch{Status: &status, UpdatedAt: now}); err != nil {
			return syncResult{}, err
		}
		autoDisabled := true
		return failedResult(source.ID, source.Name, "未配置邮箱", &autoDisabled), nil
	}

	adapter := getAdapter(source.Type)
	if adapter == nil {
		return failedResult(source.ID, source.Name, "不支持的采集源类型", nil), nil
	}

	// 迁移旧 paths 模型：有 paths 无 branches 时，从 paths 提取分支名转为 branches。
	if source.Type == "git-local" {
		if migrated, ok := migrateLegacyPaths(source.Config); ok {
			now := unixSeconds(time.Now())
			if err := applySourcePatch(ctx, queries, source.ID, sourcePatch{Config: migrated, UpdatedAt: now}); err != nil {
				return syncResult{}, err
			}
			source.Config = migrated
		}
	}

	result, err := runSync(ctx, queries, source, adapter, resync)
	if err == nil {
		return result, nil
	}

	// sync.ts 的外层 catch：错误文案进 result.error，git-local 的路径类错误顺带
	// 把采集源标记为 unavailable。
	message := err.Error()
	if classifySyncError(source.Type, message) {
		status := "unavailable"
		failedStatus := "failed"
		now := unixSeconds(time.Now())
		if patchErr := applySourcePatch(ctx, queries, source.ID, sourcePatch{
			Status:         &status,
			LastSyncStatus: &failedStatus,
			UpdatedAt:      now,
		}); patchErr != nil {
			return syncResult{}, patchErr
		}
		autoDisabled := true
		return failedResult(source.ID, source.Name, message, &autoDisabled), nil
	}

	failedStatus := "failed"
	now := unixSeconds(time.Now())
	if patchErr := applySourcePatch(ctx, queries, source.ID, sourcePatch{
		LastSyncStatus: &failedStatus,
		UpdatedAt:      now,
	}); patchErr != nil {
		return syncResult{}, patchErr
	}
	// sync.ts 的 catch 总是把 isUnavailable（此处 false）传进 failedResult，因此
	// 响应里 autoDisabled 键存在。
	autoDisabled := false
	return failedResult(source.ID, source.Name, message, &autoDisabled), nil
}

// migrateLegacyPaths 复刻 sync.ts 的 legacy paths 迁移：
// `[...new Set(paths.map(p => p.lastBranch).filter(Boolean))]` → branches 对象数组；
// 同时删除 paths 键。第二个返回值表示是否发生迁移。
func migrateLegacyPaths(config sourceConfig) (sourceConfig, bool) {
	paths, ok := config[keyPaths].([]any)
	if !ok || len(paths) == 0 {
		return nil, false
	}

	branchNames := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, raw := range paths {
		path, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, ok := path["lastBranch"].(string)
		if !ok || name == "" {
			continue
		}
		if _, duplicate := seen[name]; duplicate {
			continue
		}
		seen[name] = struct{}{}
		branchNames = append(branchNames, name)
	}

	branches := make([]any, 0, len(branchNames))
	for _, name := range branchNames {
		branches = append(branches, map[string]any{"name": name, "lastCommitTime": nil})
	}

	next := make(sourceConfig, len(config))
	for key, value := range config {
		if key == keyPaths {
			continue
		}
		next[key] = value
	}
	next[keyBranches] = branches
	return next, true
}

// runSync 是 sync.ts 里那个大 try 块，返回 syncResult 或「应向上抛的错误」。
func runSync(ctx context.Context, queries *db.Queries, source sourceRecord, adapter gitAdapter, resync bool) (syncResult, error) {
	repoName := resolveRepoName(ctx, source)
	now := time.Now()

	var allCommits []gitCommit
	type branchCommit struct {
		commit     gitCommit
		branchName string
	}
	branchCommits := make([]branchCommit, 0, 16)
	branchMaxCommitterDate := make(map[string]time.Time)
	branchResults := make([]branchSyncResult, 0, 4)

	// collectOneBranch 是 TS 里同名闭包：单分支采集 + 结果记账。
	collectOneBranch := func(branchName string, cursorTime *string, skipPull bool) {
		var since *time.Time
		if !resync && cursorTime != nil {
			parsed, ok := parseJSTime(*cursorTime)
			if !ok {
				message := "Invalid time value"
				branchResults = append(branchResults, branchSyncResult{
					Name: branchName, Status: "failed", CommitsCount: 0, Error: &message,
				})
				return
			}
			since = &parsed
		}

		until := now
		commits, err := adapter.fetchCommits(ctx, fetchOptions{
			Config:   source.Config,
			Branch:   branchName,
			Since:    since,
			Until:    &until,
			SkipPull: skipPull,
		})
		if err != nil {
			message := err.Error()
			branchResults = append(branchResults, branchSyncResult{
				Name: branchName, Status: "failed", CommitsCount: 0, Error: &message,
			})
			return
		}

		allCommits = append(allCommits, commits...)
		for _, commit := range commits {
			branchCommits = append(branchCommits, branchCommit{commit: commit, branchName: branchName})
		}
		if len(commits) > 0 {
			max := commits[0].CommitterDate
			for _, commit := range commits[1:] {
				if commit.CommitterDate.After(max) {
					max = commit.CommitterDate
				}
			}
			branchMaxCommitterDate[branchName] = max
		}
		branchResults = append(branchResults, branchSyncResult{
			Name: branchName, Status: "success", CommitsCount: len(commits),
		})
	}

	allBranchesMode := source.Type == "git-local" && isEmptyBranchConfig(source.Config[keyBranches])

	if allBranchesMode {
		repoPath := source.Config.stringValue(keyOwner)
		// 无效/缺失路径 → 向上抛 → 外层标记 unavailable。
		if err := assertLocalGitRepo(ctx, repoPath); err != nil {
			return syncResult{}, err
		}
		localHeads := getLocalBranchNames(ctx, repoPath)
		currentBranch := getCurrentBranch(ctx, repoPath)
		orderedBranches := orderBranchesForAttribution(localHeads, currentBranch)

		// 全分支模式下只拉取当前签出分支一次（best-effort），其余分支直接读本地历史。
		if err := pullCurrentBranch(ctx, repoPath); err != nil {
			log.Printf("全分支采集：pull 当前分支失败，继续使用本地 commit: %v", err)
		}

		cursorMap := make(map[string]*string, 4)
		for _, cursor := range parseBranchCursors(source.Config[keyBranchCursors]) {
			if _, ok := cursorMap[cursor.Name]; ok {
				continue
			}
			cursorMap[cursor.Name] = cursor.LastCommitTime
		}

		for _, branchName := range orderedBranches {
			collectOneBranch(branchName, cursorMap[branchName], true)
		}

		failedBranches := filterFailedBranches(branchResults)
		allBranchesFailed := len(orderedBranches) > 0 && len(failedBranches) == len(orderedBranches)
		if allBranchesFailed {
			message := "全部分支同步失败：" + firstBranchError(failedBranches)
			status := "failed"
			nowSeconds := unixSeconds(now)
			if err := applySourcePatch(ctx, queries, source.ID, sourcePatch{LastSyncStatus: &status, UpdatedAt: nowSeconds}); err != nil {
				return syncResult{}, err
			}
			return failedResult(source.ID, source.Name, message, nil), nil
		}

		events := make([]rawEventData, 0, len(branchCommits))
		for _, item := range branchCommits {
			events = append(events, normalizeLocalCommit(item.commit, source.Type, repoName, item.branchName, source.ID, source.Name))
		}
		eventsCount, err := insertNewEvents(ctx, queries, source.ID, events, now)
		if err != nil {
			return syncResult{}, err
		}

		newCursors := buildPrunedBranchCursors(localHeads, branchMaxCommitterDate, parseBranchCursors(source.Config[keyBranchCursors]))
		updatedConfig := source.Config.with(keyBranchCursors, newCursors)

		lastSyncAt := unixSeconds(now)
		success := "success"
		if err := applySourcePatch(ctx, queries, source.ID, sourcePatch{
			Config:         updatedConfig,
			LastSyncAt:     &lastSyncAt,
			LastSyncStatus: &success,
			UpdatedAt:      unixSeconds(now),
		}); err != nil {
			return syncResult{}, err
		}

		return syncResult{
			SourceID:     source.ID,
			SourceName:   source.Name,
			Status:       "success",
			CommitsCount: len(allCommits),
			EventsCount:  eventsCount,
			Branches:     &branchResults,
		}, nil
	}

	// ---- 统一 branches 模型（git-local 显式分支 与远端类型） ----
	branches := normalizeBranches(source.Config[keyBranches])
	for _, branch := range branches {
		collectOneBranch(branch.Name, branch.LastCommitTime, false)
	}

	failedBranches := filterFailedBranches(branchResults)
	if len(failedBranches) == len(branchResults) {
		message := "全部分支同步失败：" + firstBranchError(failedBranches)
		status := "failed"
		nowSeconds := unixSeconds(now)
		if err := applySourcePatch(ctx, queries, source.ID, sourcePatch{LastSyncStatus: &status, UpdatedAt: nowSeconds}); err != nil {
			return syncResult{}, err
		}
		return failedResult(source.ID, source.Name, message, nil), nil
	}

	events := make([]rawEventData, 0, len(branchCommits))
	for _, item := range branchCommits {
		events = append(events, normalizeLocalCommit(item.commit, source.Type, repoName, item.branchName, source.ID, source.Name))
	}
	eventsCount, err := insertNewEvents(ctx, queries, source.ID, events, now)
	if err != nil {
		return syncResult{}, err
	}

	// 只更新本次拉到新 commit 的分支游标。
	updatedBranches := make([]normalizedBranch, 0, len(branches))
	for _, branch := range branches {
		updated := normalizedBranch{Name: branch.Name, LastCommitTime: branch.LastCommitTime}
		if max, ok := branchMaxCommitterDate[branch.Name]; ok {
			value := isoMillisFromTime(max)
			updated.LastCommitTime = &value
		}
		updatedBranches = append(updatedBranches, updated)
	}

	updatedConfig := source.Config.with(keyBranches, updatedBranches)
	lastSyncAt := unixSeconds(now)
	success := "success"
	if err := applySourcePatch(ctx, queries, source.ID, sourcePatch{
		Config:         updatedConfig,
		LastSyncAt:     &lastSyncAt,
		LastSyncStatus: &success,
		UpdatedAt:      unixSeconds(now),
	}); err != nil {
		return syncResult{}, err
	}

	return syncResult{
		SourceID:     source.ID,
		SourceName:   source.Name,
		Status:       "success",
		CommitsCount: len(allCommits),
		EventsCount:  eventsCount,
		Branches:     &branchResults,
	}, nil
}

// classifySyncError 复刻 sync.ts 外层 catch 的 unavailable 判定。
func classifySyncError(sourceType, message string) bool {
	if sourceType != "git-local" {
		return false
	}
	markers := []string{
		"路径不是 Git 仓库",
		"本地仓库路径不存在",
		"not a git repository",
		"no such file or directory",
		"ENOENT",
	}
	for _, marker := range markers {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func filterFailedBranches(results []branchSyncResult) []branchSyncResult {
	failed := make([]branchSyncResult, 0, len(results))
	for _, result := range results {
		if result.Status == "failed" {
			failed = append(failed, result)
		}
	}
	return failed
}

func firstBranchError(failed []branchSyncResult) string {
	if len(failed) == 0 || failed[0].Error == nil {
		return "未知错误"
	}
	return *failed[0].Error
}

// resolveRepoName 复刻 sync.ts resolveRepoName：
// git-local 取本地仓库归一化名；远端取 owner/repo；没有 repo 时取 owner 的 basename。
func resolveRepoName(ctx context.Context, source sourceRecord) string {
	if source.Type == "git-local" {
		return getNormalizedRepoName(ctx, source.Config.stringValue(keyOwner))
	}
	if repo := source.Config.stringValue(keyRepo); repo != "" {
		return normalizeRepoName(source.Config.stringValue(keyOwner) + "/" + repo)
	}
	return jsBasename(source.Config.stringValue(keyOwner))
}

// insertNewEvents 复刻 sync.ts insertNewEvents：按 sourceId + sha 去重后插入。
func insertNewEvents(ctx context.Context, queries *db.Queries, sourceID int64, events []rawEventData, now time.Time) (int, error) {
	existingRows, err := queries.ListRawEventMetadataBySourceID(ctx, sourceID)
	if err != nil {
		return 0, err
	}

	existingSha := make(map[string]struct{}, len(existingRows))
	for _, raw := range existingRows {
		// json_extract 的 WHERE 已经排除了 NULL metadata；这里的空值防御对应
		// 「列里存的是空串」这类脏数据（JSON.parse 同样会抛）。
		if len(raw) == 0 {
			continue
		}
		var metadata map[string]any
		if err := json.Unmarshal(raw, &metadata); err != nil {
			return 0, err
		}
		if sha, ok := metadata["sha"].(string); ok && sha != "" {
			existingSha[sha] = struct{}{}
		}
	}

	seen := make(map[string]struct{}, len(events))
	newEvents := make([]rawEventData, 0, len(events))
	for _, event := range events {
		sha := event.Metadata.Sha
		if sha == "" {
			newEvents = append(newEvents, event)
			continue
		}
		if _, duplicate := seen[sha]; duplicate {
			continue
		}
		if _, exists := existingSha[sha]; exists {
			continue
		}
		seen[sha] = struct{}{}
		newEvents = append(newEvents, event)
	}

	if len(newEvents) == 0 {
		return 0, nil
	}

	createdAt := unixSeconds(now)
	err = queries.InTx(ctx, func(tx *db.Queries) error {
		for _, event := range newEvents {
			metadata, err := json.Marshal(event.Metadata)
			if err != nil {
				return err
			}
			category := event.Category
			if err := tx.InsertCollectedRawEvent(ctx, db.InsertCollectedRawEventParams{
				EventTime: unixSeconds(event.EventTime),
				Source:    event.Source,
				Content:   event.Content,
				Metadata:  string(metadata),
				Category:  &category,
				CreatedAt: createdAt,
				UpdatedAt: createdAt,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return len(newEvents), nil
}

// syncAllSources 复刻 syncAllSources：只同步 enabled 且配置了邮箱的来源，逐个串行。
func syncAllSources(ctx context.Context, queries *db.Queries, resync bool) ([]syncResult, error) {
	rows, err := queries.ListEnabledCollectSources(ctx)
	if err != nil {
		return nil, err
	}

	results := make([]syncResult, 0, len(rows))
	for _, row := range rows {
		source, err := sourceRecordFromList(row)
		if err != nil {
			return nil, err
		}
		// 过滤掉没有配置邮箱的采集源（和单个同步按钮行为一致）。
		if !source.Config.hasAuthorEmail() {
			continue
		}
		result, err := syncSource(ctx, queries, source.ID, resync)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}
