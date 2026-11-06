package additions

import (
	"os"
	"path/filepath"
	"strings"
)

// scanForGitRepos 复刻 src/app/collect/actions.ts 的扫描语义：
//
//   - 容器自身永远不算结果（顶层 checkForRepository=false），即使它带 .git；
//   - 子目录只要存在 `.git`（目录 = 常规仓库，文件 = worktree/submodule 工作树）
//     就算仓库，并停止下钻；
//   - 只下钻非隐藏目录；`currentDepth > maxDepth` 才停（不是 `>=`）；
//   - 读目录失败静默跳过（TS 的 `catch {}`）。
//
// 与 Node 的一处实现差异：os.ReadDir 按文件名排序，Node 的 readdirSync 是目录项
// 原始顺序。顺序不在 HTTP 契约内（TS 侧本来也依赖文件系统），结果集合一致。
func scanForGitRepos(basePath string, maxDepth float64) []string {
	repos := make([]string, 0)

	var scan func(currentPath string, currentDepth int, checkForRepository bool)
	scan = func(currentPath string, currentDepth int, checkForRepository bool) {
		if float64(currentDepth) > maxDepth {
			return
		}
		if !exists(currentPath) {
			return
		}
		if checkForRepository && exists(filepath.Join(currentPath, ".git")) {
			repos = append(repos, currentPath)
			return
		}

		entries, err := os.ReadDir(currentPath)
		if err != nil {
			return
		}
		for _, entry := range entries {
			// DirEntry.IsDir 是 lstat 语义：符号链接不当作目录（与 Node Dirent 一致）。
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			scan(filepath.Join(currentPath, entry.Name()), currentDepth+1, true)
		}
	}

	scan(basePath, 0, false)
	return repos
}

// exists 复刻 fs.existsSync：stat（跟随符号链接）成功即存在；任何错误都算不存在。
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
