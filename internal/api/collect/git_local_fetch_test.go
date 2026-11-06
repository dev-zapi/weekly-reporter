package collect_test

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// decode 把响应体解成 map；断言失败时带上原始 body，便于定位。
func decode(t *testing.T, rec interface {
	Result() *http.Response
}) (int, map[string]any) {
	t.Helper()
	res := rec.Result()
	defer res.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return res.StatusCode, body
}

// nested 从 map 里按路径取值，缺失即 Fatal。
func nested(t *testing.T, body map[string]any, keys ...string) map[string]any {
	t.Helper()
	current := body
	for _, key := range keys {
		next, ok := current[key].(map[string]any)
		if !ok {
			t.Fatalf("%v is not an object in %v", key, body)
		}
		current = next
	}
	return current
}

// git-local fetch 的用例集与 src/app/api/collect/git-local/fetch/route.test.ts 一一对应
// （3 条），另补票面要求的白名单/git 失败面与 ID 校验。

func TestGitLocalFetchReturnsSuccessfulResult(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	origin := filepath.Join(t.TempDir(), "remote.git")
	runFixtureGit(t, "", "init", "--bare", origin)
	repo.git("remote", "add", "origin", origin)
	repo.commit("initial", gitDate(relativeTime(48), time.UTC))

	sourceID := h.seedSource(sourceSeed{sourceType: "git-local", name: "本地仓库", config: configJSON(repo.path, "")})

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch",
		`{"sourceId":`+itoa(sourceID)+`}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %v)", status, body)
	}
	result := nested(t, body, "result")
	if result["sourceName"] != "本地仓库" || result["status"] != "success" {
		t.Fatalf("result = %v", result)
	}
	if result["sourceId"] != float64(sourceID) {
		t.Fatalf("sourceId = %v, want %d", result["sourceId"], sourceID)
	}
	if _, present := result["error"]; present {
		t.Fatalf("success result must omit error: %v", result)
	}
}

func TestGitLocalFetchRejectsNonLocalSource(t *testing.T) {
	h := newHarness(t)
	sourceID := h.seedSource(sourceSeed{
		sourceType: "git-remote-github",
		name:       "GitHub",
		config:     configJSON("owner/repo", `"repo":"repo","token":"t"`),
	})

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch",
		`{"sourceId":`+itoa(sourceID)+`}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %v)", status, body)
	}
	if body["code"] != "FETCH_FAILED" {
		t.Fatalf("code = %v", body["code"])
	}
	result := nested(t, body, "result")
	if result["status"] != "failed" || result["error"] != "仅支持本地 Git 来源" {
		t.Fatalf("result = %v", result)
	}
}

func TestGitLocalFetchNotFoundForUnknownSource(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch", `{"sourceId":999}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %v)", status, body)
	}
	if body["error"] != "采集源不存在" || body["code"] != "FETCH_FAILED" {
		t.Fatalf("body = %v", body)
	}
	result := nested(t, body, "result")
	if result["sourceName"] != "" {
		t.Fatalf("sourceName = %v, want empty string", result["sourceName"])
	}
}

// sourceId 走 Number() + Number.isInteger：缺失、0、负数、小数与非数字字符串都是 400。
func TestGitLocalFetchRejectsInvalidSourceID(t *testing.T) {
	h := newHarness(t)

	cases := []string{
		`{}`,
		`{"sourceId":null}`,
		`{"sourceId":0}`,
		`{"sourceId":-1}`,
		`{"sourceId":1.5}`,
		`{"sourceId":"abc"}`,
		`null`,
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			rec := h.do(http.MethodPost, "/api/collect/git-local/fetch", body, testPassword)
			status, decoded := decode(t, rec)
			if status != http.StatusBadRequest || decoded["code"] != "INVALID_ID" {
				t.Fatalf("status = %d, body = %v", status, decoded)
			}
		})
	}
}

// Number() 还会把数字字符串、布尔与数组折成数字：这些输入在 route.ts 里都能通过
// Number.isInteger，所以落到正常分支（查不到 → 404），而不是 400。
func TestGitLocalFetchCoercesSourceIDLikeNumber(t *testing.T) {
	h := newHarness(t)

	cases := []string{
		`{"sourceId":"999"}`,
		`{"sourceId":true}`,  // Number(true) === 1
		`{"sourceId":[999]}`, // Number([999]) === 999
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			rec := h.do(http.MethodPost, "/api/collect/git-local/fetch", body, testPassword)
			status, decoded := decode(t, rec)
			if status != http.StatusNotFound || decoded["error"] != "采集源不存在" {
				t.Fatalf("status = %d, body = %v", status, decoded)
			}
		})
	}
}

func TestGitLocalFetchFailsWithoutOriginRemote(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	repo.commit("initial", gitDate(relativeTime(48), time.UTC))
	sourceID := h.seedSource(sourceSeed{sourceType: "git-local", name: "无 origin", config: configJSON(repo.path, "")})

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch",
		`{"sourceId":`+itoa(sourceID)+`}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %v)", status, body)
	}
	result := nested(t, body, "result")
	if result["error"] != "仓库未配置 origin 远端" {
		t.Fatalf("error = %v", result["error"])
	}
}

func TestGitLocalFetchFailsForNonRepositoryPath(t *testing.T) {
	h := newHarness(t)
	plainDir := t.TempDir()
	sourceID := h.seedSource(sourceSeed{sourceType: "git-local", name: "不是仓库", config: configJSON(plainDir, "")})

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch",
		`{"sourceId":`+itoa(sourceID)+`}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %v)", status, body)
	}
	result := nested(t, body, "result")
	want := "路径不是 Git 仓库：" + plainDir
	if result["error"] != want {
		t.Fatalf("error = %v, want %q", result["error"], want)
	}
}

func TestGitLocalFetchRequiresAuth(t *testing.T) {
	h := newHarness(t)
	sourceID := h.seedSource(sourceSeed{sourceType: "git-local", name: "本地仓库", config: configJSON(t.TempDir(), "")})

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch", `{"sourceId":`+itoa(sourceID)+`}`, "")

	status, body := decode(t, rec)
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %v)", status, body)
	}
}

// 不能解析的请求体在 route.ts 里落进 catch → 500 FETCH_ERROR（不是 400）。
func TestGitLocalFetchRejectsMalformedBody(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch", `{"sourceId":1`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "FETCH_ERROR" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["error"] != "仓库 Fetch 失败" {
		t.Fatalf("error = %v", body["error"])
	}
}

// 读库失败（连接已关）同样是 catch 分支：500 FETCH_ERROR。
func TestGitLocalFetchMapsDatabaseErrorsToFetchError(t *testing.T) {
	h := newHarness(t)
	sourceID := h.seedSource(sourceSeed{sourceType: "git-local", name: "本地仓库", config: configJSON(t.TempDir(), "")})
	h.breakDB()

	rec := h.do(http.MethodPost, "/api/collect/git-local/fetch",
		`{"sourceId":`+itoa(sourceID)+`}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "FETCH_ERROR" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
}

// itoa 拼请求体里的整数文本。
func itoa(v int64) string { return strconv.FormatInt(v, 10) }

// runFixtureGit 在指定目录里跑一条 git 命令（dir 为空时用当前工作目录）。
func runFixtureGit(t *testing.T, dir string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture Author", "GIT_AUTHOR_EMAIL="+fixtureEmail,
		"GIT_COMMITTER_NAME=Fixture Author", "GIT_COMMITTER_EMAIL="+fixtureEmail)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
