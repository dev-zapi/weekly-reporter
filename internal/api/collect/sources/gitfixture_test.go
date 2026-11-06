package sources_test

import (
	"net/url"
	"os/exec"
	"strings"
	"testing"
)

// 本文件提供 git 面的临时仓库 fixture（route.ts 的 branches/emails 本地分支），
// 与 B4 git 执行票同一手法：真 git、真仓库、不 mock exec。

func initGitRepo(t *testing.T) string {
	t.Helper()

	repo := t.TempDir()
	runGitTest(t, repo, "init", "-q", "-b", "main")
	return repo
}

func commitAs(t *testing.T, repo, name, email, message string) {
	t.Helper()

	runGitTest(t, repo, "-c", "user.name="+name, "-c", "user.email="+email, "commit", "-q", "--allow-empty", "-m", message)
}

func createBranch(t *testing.T, repo, name string) {
	t.Helper()

	runGitTest(t, repo, "branch", name)
}

func runGitTest(t *testing.T, dir string, args ...string) string {
	t.Helper()

	command := exec.Command("git", args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func queryEscape(value string) string { return url.QueryEscape(value) }
