package collect

import (
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode/utf16"

	"github.com/dev-zapi/weekly-reporter/internal/api/collect/collectpath"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件复刻 src/app/api/collect/scan-path/route.ts：目录补全。
//
// 它是采集域里唯一读文件系统的路由，白名单（HOME//home//opt//srv//var//tmp）与
// 扫描深度都由本文件负责；白名单判定见 paths.go。

// scanMaxDepth 是 collectDirs 的默认深度（route.ts 的 maxDepth = 3）。
const scanMaxDepth = 3

type directoryItem struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Score 只在「basePath 存在 + query 非空」的映射里出现（route.ts 的
	// `allDirs.map(d => ({...d, score}))`）；其余分支的对象字面量没有这个键。
	Score *int `json:"score,omitempty"`
}

type scoredDirectory struct {
	Name  string
	Path  string
	Score int
}

// scanPathHandler 复刻 GET /api/collect/scan-path。
func scanPathHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.Query().Get("path")

		// 路径展开后必为绝对路径；空输入或裸 ~ 视为列出 $HOME 内容。
		input := collectpath.ExpandInputPath(raw)
		if jsstr.Trim(raw) == "" || jsstr.Trim(raw) == "~" {
			input += "/"
		}

		lastSlash := strings.LastIndex(input, "/")
		var basePath, query string
		if lastSlash == 0 {
			basePath = "/"
			query = input[1:]
		} else {
			basePath = input[:lastSlash]
			if basePath == "" {
				basePath = "/"
			}
			query = input[lastSlash+1:]
		}

		resolvedBase := collectpath.Resolve(basePath)
		if !isPathAllowed(resolvedBase) {
			respond.Error(w, http.StatusForbidden, "不允许访问此目录", "FORBIDDEN")
			return
		}

		exists := isDirectory(resolvedBase)

		// basePath 存在：列出子目录，如有 query 则做模糊过滤。
		if exists {
			entries, err := readDirectories(resolvedBase)
			if err != nil {
				writeScanError(w, err)
				return
			}

			var directories []directoryItem
			if query != "" {
				scored := make([]scoredDirectory, 0, len(entries))
				for _, entry := range entries {
					score := fuzzyScore(entry.Name, query)
					if score < 0 {
						continue
					}
					scored = append(scored, scoredDirectory{Name: entry.Name, Path: entry.Path, Score: score})
				}
				// `sort((a,b) => b.score - a.score)`：现代 V8 的 Array#sort 是稳定排序，
				// 同分项保持目录枚举顺序。sort.SliceStable 与之等价。
				sort.SliceStable(scored, func(i, j int) bool { return scored[i].Score > scored[j].Score })
				if len(scored) > 50 {
					scored = scored[:50]
				}
				directories = make([]directoryItem, 0, len(scored))
				for _, item := range scored {
					score := item.Score
					directories = append(directories, directoryItem{Name: item.Name, Path: item.Path, Score: &score})
				}
			} else {
				if len(entries) > 50 {
					entries = entries[:50]
				}
				directories = entries
			}

			respond.JSON(w, http.StatusOK, struct {
				Directories []directoryItem `json:"directories"`
				Path        string          `json:"path"`
				Exists      bool            `json:"exists"`
			}{Directories: directories, Path: resolvedBase, Exists: true})
			return
		}

		// basePath 不存在：向上找最近的存在的祖先目录，模糊搜索剩余部分。
		found, ok := findExistingBase(resolvedBase)
		if !ok {
			respond.JSON(w, http.StatusOK, struct {
				Directories []directoryItem `json:"directories"`
				Path        string          `json:"path"`
				Exists      bool            `json:"exists"`
			}{Directories: []directoryItem{}, Path: resolvedBase, Exists: false})
			return
		}

		// 将 query 与路径中不存在的部分合并作为模糊搜索词。
		nonExistingTail := strings.TrimPrefix(resolvedBase[len(found.BasePath):], "/")
		fullQuery := query
		if nonExistingTail != "" {
			if query != "" {
				fullQuery = nonExistingTail + "/" + query
			} else {
				fullQuery = nonExistingTail
			}
		}

		if jsstr.Trim(fullQuery) == "" {
			respond.JSON(w, http.StatusOK, struct {
				Directories []directoryItem `json:"directories"`
				Path        string          `json:"path"`
				Exists      bool            `json:"exists"`
			}{Directories: []directoryItem{}, Path: resolvedBase, Exists: false})
			return
		}

		if !isPathAllowed(found.BasePath) {
			respond.Error(w, http.StatusForbidden, "不允许访问此目录", "FORBIDDEN")
			return
		}

		matched := collectDirs(found.BasePath, fullQuery, scanMaxDepth, 0)
		sort.SliceStable(matched, func(i, j int) bool { return matched[i].Score > matched[j].Score })
		if len(matched) > 50 {
			matched = matched[:50]
		}
		directories := make([]directoryItem, 0, len(matched))
		for _, item := range matched {
			directories = append(directories, directoryItem{Name: item.Name, Path: item.Path})
		}

		respond.JSON(w, http.StatusOK, struct {
			Directories []directoryItem `json:"directories"`
			Path        string          `json:"path"`
			Exists      bool            `json:"exists"`
			FuzzyQuery  string          `json:"fuzzyQuery"`
			FuzzyBase   string          `json:"fuzzyBase"`
		}{Directories: directories, Path: resolvedBase, Exists: false, FuzzyQuery: fullQuery, FuzzyBase: found.BasePath})
	}
}

// writeScanError 复刻 route.ts 的 catch 分支：EACCES → 403 ACCESS_DENIED，
// 其它 → 500 SCAN_ERROR。只认 EACCES（fs.ErrPermission 还包含 EPERM，route.ts
// 对 EPERM 会走 500）。
func writeScanError(w http.ResponseWriter, err error) {
	if errors.Is(err, syscall.EACCES) {
		respond.Error(w, http.StatusForbidden, "无权限访问此目录", "ACCESS_DENIED")
		return
	}
	log.Printf("collect: scan-path: %v", err)
	respond.Error(w, http.StatusInternalServerError, "扫描目录失败", "SCAN_ERROR")
}

// readDirectories 复刻 route.ts 里「readdirSync(withFileTypes) + 过滤目录」的那段：
// 只保留目录，隐藏目录（以 `.` 开头且不是 `.` 本身）跳过。结果路径按 resolve 规范化。
func readDirectories(basePath string) ([]directoryItem, error) {
	entries, err := readDirectoryEntries(basePath)
	if err != nil {
		return nil, err
	}

	directories := make([]directoryItem, 0, len(entries))
	// 注意：readDirectoryEntries 保留文件系统原始顺序（对应 readdirSync），
	// 同分排序（sort.SliceStable）的先后因此与 route.ts 一致。
	for _, entry := range entries {
		// Dirent.isDirectory() 对符号链接返回 false（不跟随），entry.IsDir() 同语义。
		if !entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), ".") && entry.Name() != "." {
			continue
		}
		directories = append(directories, directoryItem{
			Name: entry.Name(),
			Path: collectpath.Resolve(filepath.Join(basePath, entry.Name())),
		})
	}
	return directories, nil
}

// readDirectoryEntries 复刻 `fs.readdirSync(p, {withFileTypes:true})`：`os.ReadDir`
// 会按文件名排序，而 readdirSync 返回文件系统原始顺序；同分排序的先后与 50 条截断
// 都依赖这个顺序，所以这里用 File.ReadDir(-1) 并保持原序。
func readDirectoryEntries(path string) ([]fs.DirEntry, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return file.ReadDir(-1)
}

// isDirectory 复刻 `fs.existsSync(p) && fs.statSync(p).isDirectory()`。
// statSync 跟随符号链接，与 os.Stat 一致。
func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// existingBase 是 findExistingBase 的结果。route.ts 只用 basePath（query 由
// resolvedBase 与 basePath 的差集重新算出），所以这里不带 query 字段。
type existingBase struct {
	BasePath string
}

// findExistingBase 复刻 findExistingBase：逐段向上拼路径，记录最后一个存在的目录，
// 剩下的段作为 query。
func findExistingBase(inputPath string) (existingBase, bool) {
	segments := splitPathSegments(inputPath)

	lastExistingIndex := -1
	lastExistingPath := ""
	for i := 0; i < len(segments); i++ {
		testPath := collectpath.Resolve("/" + strings.Join(segments[:i+1], "/"))
		if info, err := os.Stat(testPath); err == nil && info.IsDir() {
			lastExistingIndex = i
			lastExistingPath = testPath
		}
	}
	if lastExistingIndex < 0 {
		return existingBase{}, false
	}

	return existingBase{BasePath: lastExistingPath}, true
}

// splitPathSegments 复刻 route.ts 里 `basename` + `dirname` 的循环：把绝对路径拆成
// 非空段，根目录不产生段。
func splitPathSegments(p string) []string {
	cleaned := strings.Trim(p, "/")
	if cleaned == "" {
		return nil
	}
	return strings.Split(cleaned, "/")
}

// collectDirs 复刻 collectDirs：广度受 maxDepth 限制的递归模糊搜索。
// 命中（score >= 0）的目录不再深入，未命中的继续往下找。
func collectDirs(basePath, query string, maxDepth, currentDepth int) []scoredDirectory {
	if currentDepth >= maxDepth {
		return nil
	}

	results := make([]scoredDirectory, 0, 8)
	entries, err := readDirectoryEntries(basePath)
	if err != nil {
		// 不可读目录直接跳过（route.ts 的 `catch { }`）。
		return nil
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() {
			continue
		}
		if strings.HasPrefix(name, ".") && name != "." {
			continue
		}
		fullPath := collectpath.Resolve(filepath.Join(basePath, name))
		score := fuzzyScore(name, query)
		if score >= 0 {
			results = append(results, scoredDirectory{Name: name, Path: fullPath, Score: score})
			continue
		}
		results = append(results, collectDirs(fullPath, query, maxDepth, currentDepth+1)...)
	}
	return results
}

// fuzzyScore 复刻 fuzzyScore：
//
//	完全相等 100，前缀 90，包含 80，否则按连续匹配长度 *10 + 长度差；
//	query 的字符没能全部按顺序匹配到时返回 -1。
func fuzzyScore(name, query string) int {
	lowerName := jsLower(name)
	lowerQuery := jsLower(query)

	if lowerName == lowerQuery {
		return 100
	}
	if strings.HasPrefix(lowerName, lowerQuery) {
		return 90
	}
	if strings.Contains(lowerName, lowerQuery) {
		return 80
	}

	// JS 按 UTF-16 码元逐位比较；这里同样折成 []uint16，长度差也用码元数，
	// 否则增补平面字符的分值会与 route.ts 不同。
	nameUnits := utf16.Encode([]rune(lowerName))
	queryUnits := utf16.Encode([]rune(lowerQuery))
	qi := 0
	consecutive := 0
	maxConsecutive := 0
	lastMatch := -2
	for ni := 0; ni < len(nameUnits) && qi < len(queryUnits); ni++ {
		if nameUnits[ni] != queryUnits[qi] {
			continue
		}
		if ni == lastMatch+1 {
			consecutive++
			if consecutive > maxConsecutive {
				maxConsecutive = consecutive
			}
		} else {
			consecutive = 1
		}
		lastMatch = ni
		qi++
	}
	if qi < len(queryUnits) {
		return -1
	}
	return maxConsecutive*10 + (jsstr.UTF16Len(lowerName) - jsstr.UTF16Len(lowerQuery))
}

// jsLower 复刻 String.prototype.toLowerCase：JS 的大小写映射只在 Unicode 上，
// 与 Go 的 strings.ToLower 在极少数土耳其语/希腊语上下文规则上不同；这里用
// strings.ToLower（route.ts 的输入是文件系统目录名，两者的差异不可观测）。
func jsLower(s string) string { return strings.ToLower(s) }
