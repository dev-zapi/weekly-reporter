package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// 本文件是 src/lib/collect/adapters/ 三个适配器的 Go 对应物。同步路由按
// source.type 分派：git-local 走 exec git，git-remote-github / git-remote-gitlab
// 走仓库 API（fetch + JSON）。
//
// 适配器只负责把远端/本地历史折成 []gitCommit；事件归一化与落库由 sync.go 统一做。

// fetchOptions 对应 types.ts 的 FetchCommitsOptions。
type fetchOptions struct {
	Config sourceConfig
	// Branch 是本次要采集的分支；空串表示「仓库默认分支」（git-local 则是未指定）。
	Branch   string
	Since    *time.Time
	Until    *time.Time
	SkipPull bool
}

// gitAdapter 对应 types.ts 的 GitAdapter（platform 字段在 TS 侧也没有读取方，
// 这里不复制）。
type gitAdapter interface {
	fetchCommits(ctx context.Context, opts fetchOptions) ([]gitCommit, error)
}

// getAdapter 复刻 adapters/index.ts 的 getAdapter：未知类型返回 nil。
func getAdapter(sourceType string) gitAdapter {
	switch sourceType {
	case "git-local":
		return localGitAdapter{}
	case "git-remote-github":
		return githubAdapter{}
	case "git-remote-gitlab":
		return gitlabAdapter{}
	}
	return nil
}

// ---------- git-local ----------

type localGitAdapter struct{}

// fetchCommits 复刻 localGitAdapter.fetchCommits：
//   - 非 skipPull 时先 best-effort pull（skipPull 由 sync.go 的全分支模式传入）
//   - `git log --pretty=format:%H|%s|%ai|%ci|%ae|%an --no-merges [--since] [--until] [branch]`
//   - 只保留 authorEmails 精确命中的 commit
func (localGitAdapter) fetchCommits(ctx context.Context, opts fetchOptions) ([]gitCommit, error) {
	repoPath := opts.Config.stringValue(keyOwner)

	if !opts.SkipPull {
		if err := pullForSync(ctx, repoPath, opts.Branch); err != nil {
			return nil, err
		}
	}

	args := []string{"log", "--pretty=format:%H|%s|%ai|%ci|%ae|%an", "--no-merges"}
	if opts.Since != nil {
		args = append(args, "--since="+isoMillisFromTime(*opts.Since))
	}
	if opts.Until != nil {
		args = append(args, "--until="+isoMillisFromTime(*opts.Until))
	}
	if opts.Branch != "" {
		args = append(args, opts.Branch)
	}

	stdout, err := runGit(ctx, repoPath, args...)
	if err != nil {
		if isNotAGitRepository(err.Error()) {
			return nil, fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
		}
		// 复刻 `Git 命令执行失败：${error}`：模板字符串对 Error 调 toString()，
		// 得到 "Error: " + error.message（Node execFile 的 message 形态）。
		var gitErr *gitExecError
		if errors.As(err, &gitErr) {
			return nil, fmt.Errorf("Git 命令执行失败：Error: %s", gitErr.nodeMessage())
		}
		return nil, fmt.Errorf("Git 命令执行失败：Error: %s", err.Error())
	}

	if strings.TrimSpace(stdout) == "" {
		return []gitCommit{}, nil
	}

	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	commits := make([]gitCommit, 0, len(lines))
	for _, line := range lines {
		commit, ok := parseGitLogLine(line)
		if !ok {
			continue
		}
		if !opts.Config.includesAuthorEmail(commit.AuthorEmail) {
			continue
		}
		commits = append(commits, commit)
	}
	return commits, nil
}

// pullForSync 复刻适配器里的 pull 块：`remote` 非空时 pull 指定分支（未指定则用
// 当前分支）。内层 catch 只 warn 后继续，冲突与 not-a-repo 才向上抛。
func pullForSync(ctx context.Context, repoPath, configuredBranch string) error {
	remotes, err := runGit(ctx, repoPath, "remote")
	if err != nil {
		if isNotAGitRepository(err.Error()) {
			return fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
		}
		return nil
	}
	if strings.TrimSpace(remotes) == "" {
		return nil
	}

	currentBranch := configuredBranch
	if currentBranch == "" {
		stdout, err := runGit(ctx, repoPath, "branch", "--show-current")
		if err != nil {
			return classifyPullError(err.Error(), repoPath)
		}
		currentBranch = strings.TrimSpace(stdout)
	}

	if _, err := runGit(ctx, repoPath, "pull", "--no-edit", "origin", currentBranch); err != nil {
		return classifyPullError(err.Error(), repoPath)
	}
	return nil
}

// classifyPullError 复刻适配器 pull 块里对错误的分类：冲突与 not-a-repo 抛出，
// 其余（含无 upstream 之类）只 warn 后继续，所以返回 nil。
func classifyPullError(message, repoPath string) error {
	if strings.Contains(message, "CONFLICT") || strings.Contains(message, "conflict") {
		return errors.New("Git pull 有冲突，请手动解决后再同步")
	}
	if isNotAGitRepository(message) {
		return fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
	}
	return nil
}

// parseGitLogLine 拆 `%H|%s|%ai|%ci|%ae|%an`。与 JS 的
// `const [sha, message, authorDateStr, ...] = line.split('|')` 一致：字段里含 `|`
// 时取位整体前移（TS 同样如此），这里镜像同样的取位。少于 6 段时 JS 会得到
// undefined 字段并让 `new Date(undefined)` 变 Invalid Date——那条路径不会出现在
// 正常 git 输出里，这里直接跳过该行。
func parseGitLogLine(line string) (gitCommit, bool) {
	parts := strings.Split(line, "|")
	if len(parts) < 6 {
		return gitCommit{}, false
	}

	authorDate, err := parseGitDate(parts[2])
	if err != nil {
		return gitCommit{}, false
	}
	committerDate, err := parseGitDate(parts[3])
	if err != nil {
		return gitCommit{}, false
	}

	return gitCommit{
		Sha:           parts[0],
		Message:       parts[1],
		AuthorDate:    authorDate,
		CommitterDate: committerDate,
		AuthorEmail:   parts[4],
		AuthorName:    parts[5],
	}, true
}

// parseGitDate 解析 git 的 `%ai` / `%ci`：`YYYY-MM-DD HH:MM:SS ±HHMM`。
// V8 的 `new Date()` 对这种历史格式按显式时区解释（已用 node 验证），这里用同语义
// 的固定 layout；jsdate 只覆盖 ECMAScript 的严格格式，不接受这种写法。
func parseGitDate(value string) (time.Time, error) {
	parsed, err := time.Parse("2006-01-02 15:04:05 -0700", value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

// ---------- 远端（GitHub / GitLab） ----------

type githubAdapter struct{}

type githubCommit struct {
	Sha    string `json:"sha"`
	Commit struct {
		Message string `json:"message"`
		Author  struct {
			Date  string `json:"date"`
			Email string `json:"email"`
			Name  string `json:"name"`
		} `json:"author"`
		Committer struct {
			Date string `json:"date"`
		} `json:"committer"`
	} `json:"commit"`
	HTMLURL string `json:"html_url"`
}

// fetchCommits 复刻 github-adapter.ts：校验 repo/token，拼 commits 列表请求，
// 按状态码映射错误文案，再按 authorEmails 过滤。
func (githubAdapter) fetchCommits(ctx context.Context, opts fetchOptions) ([]gitCommit, error) {
	owner := opts.Config.stringValue(keyOwner)
	repo := opts.Config.stringValue(keyRepo)

	if repo == "" {
		return nil, errors.New("GitHub 仓库需要指定 repo")
	}
	token := opts.Config.stringValue(keyToken)
	if token == "" {
		return nil, errors.New("GitHub 仓库需要提供 token")
	}

	apiBase := opts.Config.stringValue(keyBaseURL)
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}

	query := url.Values{}
	query.Set("per_page", "100")
	if opts.Since != nil {
		query.Set("since", isoMillisFromTime(*opts.Since))
	}
	if opts.Until != nil {
		query.Set("until", isoMillisFromTime(*opts.Until))
	}
	if opts.Branch != "" {
		query.Set("sha", opts.Branch)
	}

	requestURL := fmt.Sprintf("%s/repos/%s/%s/commits?%s", apiBase, owner, repo, query.Encode())
	headers := map[string]string{
		"Authorization": "Bearer " + token,
		"Accept":        "application/vnd.github.v3+json",
		"User-Agent":    "WeeklyReporter",
	}

	body, status, err := fetchJSON(ctx, requestURL, headers)
	if err != nil {
		return nil, err
	}
	switch {
	case status == http.StatusNotFound:
		return nil, fmt.Errorf("仓库不存在或无权限访问: %s/%s", owner, repo)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return nil, errors.New("令牌无效或权限不足")
	case status < 200 || status >= 300:
		return nil, fmt.Errorf("GitHub API 错误: %d", status)
	}

	var commits []githubCommit
	if err := json.Unmarshal(body, &commits); err != nil {
		return nil, err
	}

	result := make([]gitCommit, 0, len(commits))
	for _, item := range commits {
		if !opts.Config.includesAuthorEmail(item.Commit.Author.Email) {
			continue
		}
		authorDate, err := parseAPIDate(item.Commit.Author.Date)
		if err != nil {
			return nil, err
		}
		committerDate, err := parseAPIDate(item.Commit.Committer.Date)
		if err != nil {
			return nil, err
		}
		result = append(result, gitCommit{
			Sha:           item.Sha,
			Message:       item.Commit.Message,
			AuthorDate:    authorDate,
			CommitterDate: committerDate,
			AuthorEmail:   item.Commit.Author.Email,
			AuthorName:    item.Commit.Author.Name,
			URL:           item.HTMLURL,
		})
	}
	return result, nil
}

type gitlabAdapter struct{}

type gitlabCommit struct {
	ID            string `json:"id"`
	Message       string `json:"message"`
	AuthoredDate  string `json:"authored_date"`
	CommittedDate string `json:"committed_date"`
	AuthorEmail   string `json:"author_email"`
	AuthorName    string `json:"author_name"`
	WebURL        string `json:"web_url"`
}

// fetchCommits 复刻 gitlab-adapter.ts。
func (gitlabAdapter) fetchCommits(ctx context.Context, opts fetchOptions) ([]gitCommit, error) {
	owner := opts.Config.stringValue(keyOwner)
	repo := opts.Config.stringValue(keyRepo)

	if repo == "" {
		return nil, errors.New("GitLab 仓库需要指定 repo")
	}
	token := opts.Config.stringValue(keyToken)
	if token == "" {
		return nil, errors.New("GitLab 仓库需要提供 token")
	}

	apiBase := opts.Config.stringValue(keyBaseURL)
	if apiBase == "" {
		apiBase = "https://gitlab.com/api/v4"
	}

	projectID := encodeURIComponent(owner + "/" + repo)

	query := url.Values{}
	query.Set("per_page", "100")
	if opts.Since != nil {
		query.Set("since", isoMillisFromTime(*opts.Since))
	}
	if opts.Until != nil {
		query.Set("until", isoMillisFromTime(*opts.Until))
	}
	if opts.Branch != "" {
		query.Set("ref_name", opts.Branch)
	}

	requestURL := fmt.Sprintf("%s/projects/%s/repository/commits?%s", apiBase, projectID, query.Encode())
	headers := map[string]string{
		"PRIVATE-TOKEN": token,
		"Accept":        "application/json",
	}

	body, status, err := fetchJSON(ctx, requestURL, headers)
	if err != nil {
		return nil, err
	}
	switch {
	case status == http.StatusNotFound:
		return nil, fmt.Errorf("仓库不存在或无权限访问: %s/%s", owner, repo)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return nil, errors.New("令牌无效或权限不足")
	case status < 200 || status >= 300:
		return nil, fmt.Errorf("GitLab API 错误: %d", status)
	}

	var commits []gitlabCommit
	if err := json.Unmarshal(body, &commits); err != nil {
		return nil, err
	}

	result := make([]gitCommit, 0, len(commits))
	for _, item := range commits {
		if !opts.Config.includesAuthorEmail(item.AuthorEmail) {
			continue
		}
		authorDate, err := parseAPIDate(item.AuthoredDate)
		if err != nil {
			return nil, err
		}
		committerDate, err := parseAPIDate(item.CommittedDate)
		if err != nil {
			return nil, err
		}
		result = append(result, gitCommit{
			Sha:           item.ID,
			Message:       item.Message,
			AuthorDate:    authorDate,
			CommitterDate: committerDate,
			AuthorEmail:   item.AuthorEmail,
			AuthorName:    item.AuthorName,
			URL:           item.WebURL,
		})
	}
	return result, nil
}

// fetchJSON 发一个 GET，返回 body 与状态码。非 2xx 也照常返回 body/status，由调用方
// 按 route.ts 的分支映射错误文案（fetch 本身只在网络层失败时抛错）。
func fetchJSON(ctx context.Context, requestURL string, headers map[string]string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, 0, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	// outboundTraceHeaders()：traceparent + x-trace-id；无 trace 上下文时不加。
	if tc, ok := trace.FromContext(ctx); ok {
		req.Header.Set("traceparent", trace.TraceParent(tc.TraceID, tc.SpanID))
		req.Header.Set("x-trace-id", tc.TraceID)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, 0, err
	}
	return body, res.StatusCode, nil
}

// parseAPIDate 解析远端 API 的 ISO 8601 时间戳（`new Date(str)` 的可观测结果）。
func parseAPIDate(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, errors.New("Invalid time value")
	}
	return parsed.UTC(), nil
}

// encodeURIComponent 复刻 JS 的 encodeURIComponent（GitLab 的 project id 用它）。
// 未保留字符集与 ECMAScript 一致：字母数字加 `-_.!~*'()`，其余按 UTF-8 字节
// 百分号编码。
func encodeURIComponent(value string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}
