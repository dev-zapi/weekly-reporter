package sources

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"sort"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/db"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件复刻 GET /api/collect/sources/branches 与 emails 的「provider + 本地 git」
// 取数逻辑。git 一律走 exec（与 route.ts 的 execFile 同语义，不绑定库），失败时
// 按 route.ts 的约定返回空列表而不是抛错；远端调用失败同样回退成空列表。

// fetchJSON 复刻 `const res = await fetch(...); if (!res.ok) return []; data = await res.json()`。
// 网络错误、非 2xx、JSON 解析失败都返回 false，由调用方回退成 []。
func fetchJSON(do func(*http.Request) (*http.Response, error), request *http.Request, out any) bool {
	response, err := do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return false
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return false
	}
	if err := json.Unmarshal(body, out); err != nil {
		return false
	}
	return true
}

// branchNameResponse 是三个 provider 的 branches 接口共同的投影。
type branchNameResponse struct {
	Name string `json:"name"`
}

// getLocalBranches 复刻 `git branch -a --format=%(refname:short)`：
// 去空行、去掉 origin/ 前缀、按首次出现去重、再按默认 sort() 排序。
func getLocalBranches(repoPath string) []string {
	output, err := runGit(repoPath, "branch", "-a", "--format=%(refname:short)")
	if err != nil {
		return []string{}
	}
	lines := strings.Split(jsTrim(output), "\n")
	seen := map[string]struct{}{}
	branches := make([]string, 0, len(lines))
	for _, line := range lines {
		if line == "" {
			continue
		}
		name := strings.TrimPrefix(line, "origin/")
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		branches = append(branches, name)
	}
	jsSortStrings(branches)
	return branches
}

// getCurrentBranch 复刻 `git branch --show-current`，detached HEAD / 非仓库返回空串。
func getCurrentBranch(repoPath string) string {
	output, err := runGit(repoPath, "branch", "--show-current")
	if err != nil {
		return ""
	}
	return jsTrim(output)
}

// lookupSource 按 id 读采集源。found=false 覆盖「不存在」与「id 超出 int64
// （JS 绑定 REAL，相等比较恒假）」两种情形。
func lookupSource(r *http.Request, deps Deps, sourceID float64) (db.CollectSourceRecord, bool, error) {
	if sourceID < -9223372036854775808.0 || sourceID >= 9223372036854775808.0 {
		return db.CollectSourceRecord{}, false, nil
	}
	row, err := deps.Queries.GetCollectSource(r.Context(), int64(sourceID))
	if errors.Is(err, sql.ErrNoRows) {
		return db.CollectSourceRecord{}, false, nil
	}
	if err != nil {
		return db.CollectSourceRecord{}, false, err
	}
	record := row.Record()
	if !isValidStoredConfig(record.Config) {
		// drizzle 的 findFirst 会 JSON.parse config；损坏的行让整条路由进 catch。
		return db.CollectSourceRecord{}, false, errInvalidStoredConfig
	}
	return record, true, nil
}

// errInvalidStoredConfig 表示存量 config 不是合法 JSON（route.ts 的 findFirst 会抛错）。
var errInvalidStoredConfig = errors.New("collect sources: stored config is not valid JSON")

func runGit(dir string, args ...string) (string, error) {
	command := exec.Command("git", args...)
	command.Dir = dir
	output, err := command.Output()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

// getGitHubBranches 复刻 GitHub branches 接口。
func getGitHubBranches(do func(*http.Request) (*http.Response, error), owner, repo, token string) []string {
	request, err := http.NewRequest(http.MethodGet, "https://api.github.com/repos/"+owner+"/"+repo+"/branches?per_page=100", nil)
	if err != nil {
		return []string{}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	var data []branchNameResponse
	if !fetchJSON(do, request, &data) {
		return []string{}
	}
	names := make([]string, 0, len(data))
	for _, item := range data {
		names = append(names, item.Name)
	}
	jsSortStrings(names)
	return names
}

// getGitLabBranches 复刻 GitLab branches 接口（baseUrl 可指向自建实例）。
func getGitLabBranches(do func(*http.Request) (*http.Response, error), owner, repo, token, baseURL string) []string {
	host := baseURL
	if host == "" {
		host = "https://gitlab.com"
	}
	projectPath := encodeURIComponent(owner + "/" + repo)
	request, err := http.NewRequest(http.MethodGet, host+"/api/v4/projects/"+projectPath+"/repository/branches?per_page=100", nil)
	if err != nil {
		return []string{}
	}
	request.Header.Set("PRIVATE-TOKEN", token)

	var data []branchNameResponse
	if !fetchJSON(do, request, &data) {
		return []string{}
	}
	names := make([]string, 0, len(data))
	for _, item := range data {
		names = append(names, item.Name)
	}
	jsSortStrings(names)
	return names
}

// getGiteeBranches 复刻 Gitee branches 接口（token 走 query string）。
func getGiteeBranches(do func(*http.Request) (*http.Response, error), owner, repo, token string) []string {
	request, err := http.NewRequest(http.MethodGet, "https://gitee.com/api/v5/repos/"+owner+"/"+repo+"/branches?per_page=100&access_token="+token, nil)
	if err != nil {
		return []string{}
	}
	request.Header.Set("Accept", "application/json")

	var data []branchNameResponse
	if !fetchJSON(do, request, &data) {
		return []string{}
	}
	names := make([]string, 0, len(data))
	for _, item := range data {
		names = append(names, item.Name)
	}
	jsSortStrings(names)
	return names
}

// encodeURIComponent 复刻 ECMAScript 的 encodeURIComponent：不转义
// A-Za-z0-9-_.!~*'()，其余按 UTF-8 字节 %XX。
func encodeURIComponent(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var builder strings.Builder
	for i := 0; i < len(value); i++ {
		b := value[i]
		if strings.IndexByte(unreserved, b) >= 0 {
			builder.WriteByte(b)
			continue
		}
		builder.WriteByte('%')
		builder.WriteString(hexByte(b))
	}
	return builder.String()
}

func hexByte(b byte) string {
	const digits = "0123456789ABCDEF"
	return string([]byte{digits[b>>4], digits[b&0x0f]})
}

// branchesHandler 复刻 GET /api/collect/sources/branches：
// 编辑表单不会拿到存量 token，所以 sourceId 有效且未传 token 时回退到库里的 token。
func branchesHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		queryType := query.Get("type")
		requestPath := ""
		if raw := query.Get("path"); raw != "" {
			requestPath = expandInputPath(raw)
		}
		owner := query.Get("owner")
		repo := query.Get("repo")
		token := query.Get("token")
		baseURL := query.Get("baseUrl")
		sourceID, sourceIDInteger := numberFromQuery(query.Get("sourceId"))

		// route.ts 只要 sourceId 有效就查一次库（无论表单是否已带 token）；读库
		// 失败/配置损坏都会落进 catch → {branches: []}。
		if sourceIDInteger && sourceID > 0 {
			record, found, err := lookupSource(r, deps, sourceID)
			if err != nil {
				respond.JSON(w, http.StatusOK, struct {
					Branches []string `json:"branches"`
				}{Branches: []string{}})
				return
			}
			if found && token == "" {
				if storedToken, ok := storedConfigToken(record.Config); ok {
					token = storedToken
				}
			}
		}

		branches := []string{}
		currentBranch := ""
		switch {
		case queryType == "git-local" && requestPath != "":
			branches = getLocalBranches(requestPath)
			currentBranch = getCurrentBranch(requestPath)
		case queryType == "git-remote-github" && owner != "" && repo != "" && token != "":
			branches = getGitHubBranches(deps.httpDo(), owner, repo, token)
		case queryType == "git-remote-gitlab" && owner != "" && repo != "" && token != "":
			branches = getGitLabBranches(deps.httpDo(), owner, repo, token, baseURL)
		case queryType == "git-remote-gitee" && owner != "" && repo != "" && token != "":
			branches = getGiteeBranches(deps.httpDo(), owner, repo, token)
		}

		respond.JSON(w, http.StatusOK, struct {
			Branches      []string `json:"branches"`
			CurrentBranch string   `json:"currentBranch"`
		}{Branches: branches, CurrentBranch: currentBranch})
	}
}

// emailsHandler 复刻 GET /api/collect/sources/emails。
func emailsHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		queryType := query.Get("type")
		requestPath := query.Get("path")
		owner := query.Get("owner")
		repo := query.Get("repo")
		token := query.Get("token")
		baseURL := query.Get("baseUrl")
		branch := query.Get("branch")
		sourceID, sourceIDInteger := numberFromQuery(query.Get("sourceId"))

		effectiveToken := token
		if effectiveToken == "" && queryType != "git-local" && sourceIDInteger && sourceID > 0 {
			record, found, err := lookupSource(r, deps, sourceID)
			if err != nil {
				// 读库失败与 findFirst 抛错同义：整条路由回 {authors: []}。
				respond.JSON(w, http.StatusOK, struct {
					Authors []authorInfo `json:"authors"`
				}{Authors: []authorInfo{}})
				return
			}
			if found {
				if storedToken, ok := storedConfigToken(record.Config); ok {
					effectiveToken = storedToken
				}
			}
		}

		authors := []authorInfo{}
		switch {
		case queryType == "git-local" && requestPath != "":
			authors = getLocalAuthors(expandInputPath(requestPath), branch)
		case queryType == "git-remote-github" && owner != "" && repo != "" && effectiveToken != "":
			authors = getGitHubAuthors(deps.httpDo(), owner, repo, effectiveToken)
		case queryType == "git-remote-gitlab" && owner != "" && repo != "" && effectiveToken != "":
			authors = getGitLabAuthors(deps.httpDo(), owner, repo, effectiveToken, baseURL)
		}

		respond.JSON(w, http.StatusOK, struct {
			Authors []authorInfo `json:"authors"`
		}{Authors: authors})
	}
}

// authorInfo 是响应里的作者条目（route.ts 的属性顺序：email, name, count）。
type authorInfo struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// authorCounter 保存「首次出现顺序 + 计数」，等价 JS 的 Map。
type authorCounter struct {
	order  []string
	name   map[string]string
	counts map[string]int64
}

func newAuthorCounter() *authorCounter {
	return &authorCounter{name: map[string]string{}, counts: map[string]int64{}}
}

func (c *authorCounter) add(email, name string) {
	if _, exists := c.counts[email]; exists {
		c.counts[email]++
		return
	}
	c.order = append(c.order, email)
	c.counts[email] = 1
	c.name[email] = name
}

// result 复刻 `[...map.entries()].sort((a, b) => b.count - a.count)`：稳定降序。
func (c *authorCounter) result() []authorInfo {
	authors := make([]authorInfo, 0, len(c.order))
	for _, email := range c.order {
		authors = append(authors, authorInfo{Email: email, Name: c.name[email], Count: c.counts[email]})
	}
	sort.SliceStable(authors, func(i, j int) bool { return authors[i].Count > authors[j].Count })
	return authors
}

// getLocalAuthors 复刻 `git log --pretty=format:%ae\t%an --no-merges -300 [branch]`。
func getLocalAuthors(repoPath, branch string) []authorInfo {
	args := []string{"log", "--pretty=format:%ae\t%an", "--no-merges", "-300"}
	if branch != "" {
		args = append(args, branch)
	}
	output, err := runGit(repoPath, args...)
	if err != nil {
		return []authorInfo{}
	}

	counter := newAuthorCounter()
	for _, line := range strings.Split(jsTrim(output), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		email := parts[0]
		if email == "" {
			continue
		}
		name := ""
		if len(parts) > 1 {
			name = parts[1]
		}
		if name == "" {
			name = email
		}
		counter.add(email, name)
	}
	return counter.result()
}

type githubCommit struct {
	Author *struct {
		Email string `json:"email"`
		Login string `json:"login"`
	} `json:"author"`
	Commit *struct {
		Author *struct {
			Email string `json:"email"`
			Name  string `json:"name"`
		} `json:"author"`
	} `json:"commit"`
}

// getGitHubAuthors 复刻 GitHub commits 接口的作者聚合。
func getGitHubAuthors(do func(*http.Request) (*http.Response, error), owner, repo, token string) []authorInfo {
	request, err := http.NewRequest(http.MethodGet, "https://api.github.com/repos/"+owner+"/"+repo+"/commits?per_page=100", nil)
	if err != nil {
		return []authorInfo{}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	var commits []githubCommit
	if !fetchJSON(do, request, &commits) {
		return []authorInfo{}
	}

	counter := newAuthorCounter()
	for _, commit := range commits {
		email := ""
		if commit.Author != nil {
			email = commit.Author.Email
		}
		if email == "" && commit.Commit != nil && commit.Commit.Author != nil {
			email = commit.Commit.Author.Email
		}
		if email == "" {
			continue
		}
		name := ""
		if commit.Commit != nil && commit.Commit.Author != nil {
			name = commit.Commit.Author.Name
		}
		if name == "" && commit.Author != nil {
			name = commit.Author.Login
		}
		if name == "" {
			name = email
		}
		counter.add(email, name)
	}
	return counter.result()
}

type gitlabCommit struct {
	AuthorEmail string `json:"author_email"`
	AuthorName  string `json:"author_name"`
}

// getGitLabAuthors 复刻 GitLab commits 接口的作者聚合。
func getGitLabAuthors(do func(*http.Request) (*http.Response, error), owner, repo, token, baseURL string) []authorInfo {
	host := baseURL
	if host == "" {
		host = "https://gitlab.com"
	}
	projectPath := encodeURIComponent(owner + "/" + repo)
	request, err := http.NewRequest(http.MethodGet, host+"/api/v4/projects/"+projectPath+"/repository/commits?per_page=100", nil)
	if err != nil {
		return []authorInfo{}
	}
	request.Header.Set("PRIVATE-TOKEN", token)

	var commits []gitlabCommit
	if !fetchJSON(do, request, &commits) {
		return []authorInfo{}
	}

	counter := newAuthorCounter()
	for _, commit := range commits {
		if commit.AuthorEmail == "" {
			continue
		}
		name := commit.AuthorName
		if name == "" {
			name = commit.AuthorEmail
		}
		counter.add(commit.AuthorEmail, name)
	}
	return counter.result()
}
