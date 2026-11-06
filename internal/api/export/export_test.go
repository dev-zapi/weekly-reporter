package export_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// export 没有现有 route.test（票面点名）：这里补 happy path 与 {error, code}
// 错误形状。行为逐条对照 src/app/api/export/route.ts。

type exportResponse struct {
	Content string          `json:"content"`
	Variant string          `json:"variant"`
	Format  json.RawMessage `json:"format"`
}

func decodeExport(t *testing.T, body []byte) exportResponse {
	t.Helper()
	var resp exportResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

func TestExportEchoesContentWithDefaults(t *testing.T) {
	h := newHarness(t)

	rec := h.do(`{"content":"# 周报\n完成评审"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decodeExport(t, rec.Body.Bytes())
	if resp.Content != "# 周报\n完成评审" {
		t.Fatalf("content = %q", resp.Content)
	}
	// variant 缺省是 personal，format 缺省是 markdown。
	if resp.Variant != "personal" || string(resp.Format) != `"markdown"` {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestExportAcceptsLeadershipVariant(t *testing.T) {
	h := newHarness(t)

	rec := h.do(`{"content":"content","variant":"leadership","format":"html"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeExport(t, rec.Body.Bytes())
	if resp.Variant != "leadership" || string(resp.Format) != `"html"` {
		t.Fatalf("resp = %+v", resp)
	}
}

// 未知 variant 一律折成 personal（`body.variant === 'leadership' ? ... : 'personal'`）。
func TestExportFallsBackToPersonalForUnknownVariant(t *testing.T) {
	h := newHarness(t)

	rec := h.do(`{"content":"content","variant":"whatever"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if resp := decodeExport(t, rec.Body.Bytes()); resp.Variant != "personal" {
		t.Fatalf("variant = %q, want personal", resp.Variant)
	}
}

func TestExportRejectsMissingContent(t *testing.T) {
	cases := []string{
		`{"content":""}`,
		`{"content":"   "}`,
		`{}`,
		`{"content":123}`,
		// `typeof body.content !== 'string'` 先短路，所以 null 也是 400。
		`{"content":null}`,
		`[]`,
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			h := newHarness(t)
			rec := h.do(body, testPassword)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			var resp struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if resp.Error != "Export content is required" || resp.Code != "INVALID_INPUT" {
				t.Fatalf("resp = %+v", resp)
			}
		})
	}
}

// JSON body 为 `null` 时 `body.content` 抛 TypeError，落到 catch → 500 EXPORT_ERROR。
func TestExportTreatsNullBodyAsServerError(t *testing.T) {
	h := newHarness(t)

	rec := h.do(`null`, testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Error != "Export failed" || resp.Code != "EXPORT_ERROR" {
		t.Fatalf("resp = %+v", resp)
	}
}

// `body.format ?? 'markdown'` 只对 null/undefined 兜底，其它 JSON 值原样回显。
func TestExportEchoesArbitraryFormatValue(t *testing.T) {
	h := newHarness(t)

	rec := h.do(`{"content":"x","format":null}`, testPassword)
	if resp := decodeExport(t, rec.Body.Bytes()); string(resp.Format) != `"markdown"` {
		t.Fatalf("format = %s, want markdown", resp.Format)
	}
	rec = h.do(`{"content":"x","format":5}`, testPassword)
	if resp := decodeExport(t, rec.Body.Bytes()); string(resp.Format) != `5` {
		t.Fatalf("format = %s, want 5", resp.Format)
	}
}

// request.json() 用 JSON.parse，尾随垃圾同样抛错 → catch → 500 EXPORT_ERROR。
func TestExportRejectsInvalidJSONWith500(t *testing.T) {
	cases := []string{
		"not-json",
		`{"content":"x"} trailing`,
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			h := newHarness(t)

			rec := h.do(body, testPassword)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
			}
			var resp struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatal(err)
			}
			if resp.Error != "Export failed" || resp.Code != "EXPORT_ERROR" {
				t.Fatalf("resp = %+v", resp)
			}
		})
	}
}

func TestExportRequiresAuth(t *testing.T) {
	h := newHarness(t)

	rec := h.do(`{"content":"content"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Unauthorized") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
