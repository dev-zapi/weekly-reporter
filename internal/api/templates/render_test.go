package templates_test

import (
	"net/http"
	"testing"
)

// 本文件是 src/app/api/templates/[id]/render/route.test.ts 的 Go 同用例集
// （ADR-0029：同 PR 删除 vitest 侧）。route.ts 的 GET 不读 id，任何 id 都回 410。
func TestTemplatesRenderRemoved(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodGet, "/api/templates/1/render", "")
	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Code != "TEMPLATE_RENDER_REMOVED" {
		t.Fatalf("code = %q, want TEMPLATE_RENDER_REMOVED", resp.Code)
	}
	if resp.Error != "周报模板不再由系统直接渲染，请使用终版生成接口" {
		t.Fatalf("error = %q", resp.Error)
	}
}

// 非数字 id 也一样：render 处理器不使用路径参数。
func TestTemplatesRenderIgnoresID(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodGet, "/api/templates/not-a-number/render", "")
	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}
