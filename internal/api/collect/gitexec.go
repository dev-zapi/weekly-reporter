package collect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件是 src/lib/collect/adapters/local-git-adapter.ts 的 Go 对应物：git 命令一律
// 走 exec 子进程（蓝图 §5 B4「exec git，非库绑定」），错误文案逐条照抄。
//
// 错误判定用 stderr 文本而不是退出码：route.ts 通过 err.stderr 做 includes()
// 判断（'not a git repository' / 'ENOENT' 等），文案就是行为契约的可观测部分。

// gitExecError 是一次失败的 git 调用。stderr 保留原文；spawnFailed 表示连进程都
// 没起来（目录不存在或 git 不在 PATH），此时 Node 的 error.message 是
// `spawn git ENOENT`，getGitErrorMessage 会拿它去匹配 ENOENT。
type gitExecError struct {
	command     string
	stderr      string
	spawnFailed bool
	spawnMsg    string
}

// Error 对齐 getGitErrorMessage：stderr.trim() 非空时优先，否则退回 Node 的
// error.message（spawn 失败是 `spawn git ENOENT`，退出码失败是
// `Command failed: git <args>\n<stderr>`）。
func (e *gitExecError) Error() string {
	if trimmed := jsstr.Trim(e.stderr); trimmed != "" {
		return trimmed
	}
	return e.nodeMessage()
}

// nodeMessage 复刻 Node execFile 的 error.message，供 `Git 命令执行失败：${error}`
// 这类模板插值使用（模板串对 Error 调 toString()，结果以 "Error: " 开头）。
func (e *gitExecError) nodeMessage() string {
	if e.spawnFailed {
		return e.spawnMsg
	}
	if e.stderr != "" {
		return "Command failed: git " + e.command + "\n" + e.stderr
	}
	return "Command failed: git " + e.command
}

// runGit 在 dir 下执行 git，返回 stdout；失败时返回 *gitExecError。
// execFile 的 maxBuffer 上限不复制：这里不做输出截断，超限场景对本地 git 不可达。
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		execErr := &gitExecError{command: strings.Join(args, " "), stderr: stderr.String()}
		var startErr *exec.Error
		switch {
		case errors.As(err, &startErr):
			execErr.spawnFailed = true
			execErr.spawnMsg = "spawn git ENOENT"
		case errors.Is(err, fs.ErrNotExist):
			// `cmd.Dir` 不存在时 Go 在 chdir 阶段就失败（*fs.PathError），Node 的
			// execFile 则表现为 `spawn git ENOENT`——getGitErrorMessage 的 includes
			// 判定依赖这条文案。
			execErr.spawnFailed = true
			execErr.spawnMsg = "spawn git ENOENT"
		case stderr.Len() == 0:
			// 进程启动了但没有任何 stderr（例如被信号打断）：Node 的 message 会是
			// `Command failed: ...`，这里保留 Go 的错误文本即可，不进入 ENOENT 分支。
			execErr.spawnFailed = true
			execErr.spawnMsg = err.Error()
		}
		return "", execErr
	}
	return stdout.String(), nil
}

// isNotAGitRepository 复刻 `message.includes('not a git repository')`。
func isNotAGitRepository(message string) bool {
	return strings.Contains(message, "not a git repository")
}

// isMissingPath 复刻 `message.includes('ENOENT') || message.includes('no such file or directory')`。
func isMissingPath(message string) bool {
	return strings.Contains(message, "ENOENT") || strings.Contains(message, "no such file or directory")
}

// fetchOrigin 复刻 local-git-adapter.ts 的 fetchOrigin：先确认 origin 存在（顺带
// 区分「不是仓库」与「路径不存在」），再 fetch。不修改工作树。
func fetchOrigin(ctx context.Context, repoPath string) error {
	if _, err := runGit(ctx, repoPath, "remote", "get-url", "origin"); err != nil {
		message := err.Error()
		if isNotAGitRepository(message) {
			return fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
		}
		if isMissingPath(message) {
			return fmt.Errorf("本地仓库路径不存在：%s", repoPath)
		}
		return errors.New("仓库未配置 origin 远端")
	}

	if _, err := runGit(ctx, repoPath, "fetch", "origin"); err != nil {
		if isNotAGitRepository(err.Error()) {
			return fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
		}
		return fmt.Errorf("Git Fetch 失败：%s", err.Error())
	}
	return nil
}

// getRemoteURL 复刻 getRemoteUrl：拿不到 origin 时返回空串（对应 TS 的 null）。
func getRemoteURL(ctx context.Context, repoPath string) string {
	stdout, err := runGit(ctx, repoPath, "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return jsstr.Trim(stdout)
}

// getNormalizedRepoName 复刻 getNormalizedRepoName：优先远程 URL 归一化，
// 归一化不出结果时退回目录 basename。
func getNormalizedRepoName(ctx context.Context, repoPath string) string {
	if remoteURL := getRemoteURL(ctx, repoPath); remoteURL != "" {
		if normalized := normalizeRepoName(remoteURL); normalized != "" {
			return normalized
		}
	}
	return jsBasename(repoPath)
}

// getCurrentBranch 复刻 getCurrentBranch：detached HEAD 或非仓库时返回空串。
func getCurrentBranch(ctx context.Context, repoPath string) string {
	stdout, err := runGit(ctx, repoPath, "branch", "--show-current")
	if err != nil {
		return ""
	}
	return jsstr.Trim(stdout)
}

// pullCurrentBranch 复刻 pullCurrentBranch（best-effort）：
// detached HEAD、无 remote、或非仓库时静默跳过；冲突时抛明确错误。
func pullCurrentBranch(ctx context.Context, repoPath string) error {
	remotes, err := runGit(ctx, repoPath, "remote")
	if err != nil {
		message := err.Error()
		if isNotAGitRepository(message) {
			return fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
		}
		if isMissingPath(message) {
			return fmt.Errorf("本地仓库路径不存在：%s", repoPath)
		}
		return nil
	}
	if jsstr.Trim(remotes) == "" {
		return nil
	}

	currentBranch := getCurrentBranch(ctx, repoPath)
	if currentBranch == "" {
		return nil
	}

	if _, err := runGit(ctx, repoPath, "pull", "--no-edit", "origin", currentBranch); err != nil {
		message := err.Error()
		if strings.Contains(message, "CONFLICT") || strings.Contains(message, "conflict") {
			return errors.New("Git pull 有冲突，请手动解决后再同步")
		}
		if isNotAGitRepository(message) {
			return fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
		}
		// 其余失败只告警：route.ts 用 console.warn 后继续同步本地 commit。
		return nil
	}
	return nil
}

// getLocalBranchNames 复刻 getLocalBranchNames：refs/heads 的短名，按字母升序；
// 出错返回空列表。
func getLocalBranchNames(ctx context.Context, repoPath string) []string {
	stdout, err := runGit(ctx, repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return nil
	}
	names := make([]string, 0, 8)
	for _, line := range strings.Split(stdout, "\n") {
		if name := jsstr.Trim(line); name != "" {
			names = append(names, name)
		}
	}
	// TS 侧是 `.sort()`（默认比较 UTF-16 码元）；ASCII 上与 sort.Strings 等价，
	// 非 ASCII 分支名的顺序差异不影响后续 orderBranchesForAttribution 的决定。
	sort.Strings(names)
	return names
}

// assertLocalGitRepo 复刻 assertLocalGitRepo：不是工作树时抛错（供同步标记 unavailable）。
func assertLocalGitRepo(ctx context.Context, repoPath string) error {
	if _, err := runGit(ctx, repoPath, "rev-parse", "--is-inside-work-tree"); err != nil {
		message := err.Error()
		if isMissingPath(message) {
			return fmt.Errorf("本地仓库路径不存在：%s", repoPath)
		}
		return fmt.Errorf("路径不是 Git 仓库：%s", repoPath)
	}
	return nil
}

// jsBasename 复刻 node path.basename：空输入返回空串（Go 的 filepath.Base 返回 "."）。
func jsBasename(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Base(p)
}

// normalizeRepoName 复刻 src/lib/utils.ts 的 normalizeRepoName：把远端 URL 折成
// `owner/repo`；解析不出 owner 段时返回最后一段（可能是纯目录名）。
func normalizeRepoName(urlOrPath string) string {
	if jsstr.Trim(urlOrPath) == "" {
		return ""
	}

	normalized := jsstr.Trim(urlOrPath)
	normalized = strings.TrimRight(normalized, "/") // replace(/\/+$/, '')
	normalized = strings.TrimSuffix(normalized, ".git")

	if match, ok := matchSSHForm(normalized); ok {
		normalized = match
	} else {
		normalized = trimProtocolPrefix(normalized)
		normalized = trimUserPrefix(normalized)
		if index := strings.Index(normalized, "/"); index >= 0 {
			normalized = normalized[index+1:]
		}
	}

	parts := strings.Split(normalized, "/")
	if len(parts) >= 2 {
		return parts[len(parts)-2] + "/" + parts[len(parts)-1]
	}
	return parts[len(parts)-1]
}

// matchSSHForm 复刻 `normalized.match(/^(?:[^@]+@)?[^:]+:(.+)$/)` 的捕获组。
// 注意 `[^:]+` 允许斜杠，因此 `host:owner/repo` 形态与 `host/path:owner/repo`
// 都会被匹配；捕获组是第一个冒号之后的全部内容。
func matchSSHForm(s string) (string, bool) {
	colon := strings.Index(s, ":")
	if colon <= 0 {
		// 正则里的 `[^:]+` 要求冒号前至少一个字符。
		return "", false
	}
	rest := s[colon+1:]
	if rest == "" {
		return "", false
	}
	return rest, true
}

// trimProtocolPrefix 复刻 `replace(/^(?:https?|ssh|git):\/\//, ”)`。
func trimProtocolPrefix(s string) string {
	for _, prefix := range []string{"https://", "http://", "ssh://", "git://"} {
		if strings.HasPrefix(s, prefix) {
			return s[len(prefix):]
		}
	}
	return s
}

// trimUserPrefix 复刻 `replace(/^[^@\/]+@/, ”)`：@ 必须出现在第一个 `/` 之前。
func trimUserPrefix(s string) string {
	at := strings.Index(s, "@")
	if at <= 0 {
		return s
	}
	if slash := strings.Index(s, "/"); slash >= 0 && slash < at {
		return s
	}
	return s[at+1:]
}
