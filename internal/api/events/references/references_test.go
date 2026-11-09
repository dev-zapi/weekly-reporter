package references_test

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// itoa 让路径与内容拼接保持可读（用例里大量 "/api/events/{id}/references"）。
func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// 本文件是 src/app/api/events/[id]/references/route.test.ts 的 Go 同用例集
// （ADR-0029）：5 个用例逐条对应，另补 route.ts 里可观测的分支（parseInt 语义、
// 400 / 500 的 {error} / {error, code} 形状、悬挂引用被内连接丢弃、评论排序）。
//
// 与 TS 的差异只有夹具形态：TS 用 createTestDbWithMigrations + drizzle 插入，
// Go 用 dbtest（同一个 schema.sql）+ SQL 插入；断言跑在真实 SQL 上。

type referrer struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	EventTime string `json:"eventTime"`
}

type commentReferrer struct {
	CommentID   int64   `json:"commentId"`
	PlanItemID  int64   `json:"planItemId"`
	Excerpt     string  `json:"excerpt"`
	Author      *string `json:"author"`
	CreatedAt   string  `json:"createdAt"`
	Scope       string  `json:"scope"`
	PeriodStart string  `json:"periodStart"`
	PeriodEnd   string  `json:"periodEnd"`
	MonthKey    *string `json:"monthKey"`
}

type referencesResponse struct {
	Referrers        []referrer `json:"referrers"`
	CommentReferrers struct {
		Count    int               `json:"count"`
		Comments []commentReferrer `json:"comments"`
	} `json:"commentReferrers"`
}

func decodeReferences(t *testing.T, body []byte) referencesResponse {
	t.Helper()

	var resp referencesResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

func strPtr(s string) *string { return &s }

func TestReferencesEmptyCommentReferrers(t *testing.T) {
	h := newHarness(t)
	eventID := h.seedEvent("Target event")

	rec := h.do("/api/events/" + itoa(eventID) + "/references")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	// 空集合必须是 [] 而不是 null（route.test.ts 的 toEqual({count:0,comments:[]})）。
	got := rec.Body.String()
	if !strings.Contains(got, `"referrers":[]`) {
		t.Fatalf("body = %s, want referrers:[]", got)
	}
	if !strings.Contains(got, `"commentReferrers":{"count":0,"comments":[]}`) {
		t.Fatalf("body = %s, want empty commentReferrers shape", got)
	}
}

func TestReferencesReturnsCommentReferrersWithOwningItemAndPeriod(t *testing.T) {
	h := newHarness(t)
	eventID := h.seedEvent("Target event")
	itemID := h.seedPlanItem("week", "2026-10-12", "2026-10-18", nil)
	commentID := h.seedCitation(itemID, eventID, "Decision motivated by @"+itoa(eventID), strPtr("weekly-reporter/claude"))

	rec := h.do("/api/events/" + itoa(eventID) + "/references")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	resp := decodeReferences(t, rec.Body.Bytes())
	if resp.CommentReferrers.Count != 1 || len(resp.CommentReferrers.Comments) != 1 {
		t.Fatalf("commentReferrers = %+v, want 1 comment", resp.CommentReferrers)
	}
	got := resp.CommentReferrers.Comments[0]
	if got.CommentID != commentID {
		t.Fatalf("commentId = %d, want %d", got.CommentID, commentID)
	}
	if got.PlanItemID != itemID {
		t.Fatalf("planItemId = %d, want %d", got.PlanItemID, itemID)
	}
	if got.Author == nil || *got.Author != "weekly-reporter/claude" {
		t.Fatalf("author = %v, want weekly-reporter/claude", got.Author)
	}
	if got.Scope != "week" || got.PeriodStart != "2026-10-12" || got.PeriodEnd != "2026-10-18" {
		t.Fatalf("period = %+v, want week 2026-10-12..2026-10-18", got)
	}
	if got.MonthKey != nil {
		t.Fatalf("monthKey = %v, want null", *got.MonthKey)
	}
	// createdAt 是 Date，NextResponse.json 序列化为 ISO 8601（UTC，毫秒）。
	if got.CreatedAt != "2026-10-12T00:00:00.000Z" {
		t.Fatalf("createdAt = %q, want 2026-10-12T00:00:00.000Z", got.CreatedAt)
	}
	if !strings.Contains(got.Excerpt, "@"+itoa(eventID)) {
		t.Fatalf("excerpt = %q, want it to contain @%d", got.Excerpt, eventID)
	}
}

func TestReferencesTruncatesLongCommentExcerpts(t *testing.T) {
	h := newHarness(t)
	eventID := h.seedEvent("Target event")
	itemID := h.seedPlanItem("week", "2026-10-12", "2026-10-18", nil)
	h.seedCitation(itemID, eventID, strings.Repeat("x", 200)+" @"+itoa(eventID), nil)

	rec := h.do("/api/events/" + itoa(eventID) + "/references")
	resp := decodeReferences(t, rec.Body.Bytes())

	if len(resp.CommentReferrers.Comments) != 1 {
		t.Fatalf("comments = %+v, want 1", resp.CommentReferrers.Comments)
	}
	excerpt := resp.CommentReferrers.Comments[0].Excerpt
	// 80 个字 + 省略号：route.test.ts 断言 <= 81 且以 '…' 结尾。引用标记在第 200 字
	// 之后，本来就会被截掉——TS 用例也不检查它还在。
	if len([]rune(excerpt)) > 81 {
		t.Fatalf("excerpt = %q (%d runes), want <= 81", excerpt, len([]rune(excerpt)))
	}
	if !strings.HasSuffix(excerpt, "…") {
		t.Fatalf("excerpt = %q, want it to end with …", excerpt)
	}
}

// toExcerpt 的空白口径是 ECMAScript 的 \s + trim()：换行/Tab 折叠成单空格、两端
// 去掉；U+00A0（NBSP）与 U+3000（全角空格）也算空白。route.test.ts 不覆盖这条，
// 但它是同一条 toExcerpt 的可观测行为，随用例集一起钉住。
func TestReferencesNormalizesExcerptWhitespaceLikeECMAScript(t *testing.T) {
	h := newHarness(t)
	eventID := h.seedEvent("Target event")
	itemID := h.seedPlanItem("week", "2026-10-12", "2026-10-18", nil)
	h.seedCitation(itemID, eventID, " line1\n\tline2　 @"+itoa(eventID)+"  ", nil)

	rec := h.do("/api/events/" + itoa(eventID) + "/references")
	resp := decodeReferences(t, rec.Body.Bytes())

	if len(resp.CommentReferrers.Comments) != 1 {
		t.Fatalf("comments = %+v, want 1", resp.CommentReferrers.Comments)
	}
	want := "line1 line2 @" + itoa(eventID)
	if got := resp.CommentReferrers.Comments[0].Excerpt; got != want {
		t.Fatalf("excerpt = %q, want %q", got, want)
	}
}

func TestReferencesKeepsEventReferrersAlongsideCommentReferrers(t *testing.T) {
	h := newHarness(t)
	targetID := h.seedEvent("Target event")
	referrerID := h.seedReferrer(targetID, "Mentions @"+itoa(targetID))
	itemID := h.seedPlanItem("week", "2026-10-12", "2026-10-18", nil)
	h.seedCitation(itemID, targetID, "Note @"+itoa(targetID), nil)

	rec := h.do("/api/events/" + itoa(targetID) + "/references")
	resp := decodeReferences(t, rec.Body.Bytes())

	if len(resp.Referrers) != 1 || resp.Referrers[0].ID != referrerID {
		t.Fatalf("referrers = %+v, want [%d]", resp.Referrers, referrerID)
	}
	if resp.Referrers[0].Content != "Mentions @"+itoa(targetID) {
		t.Fatalf("referrer content = %q", resp.Referrers[0].Content)
	}
	// eventTime 是 Date，序列化为 ISO 8601。
	if resp.Referrers[0].EventTime != "2026-10-12T09:00:00.000Z" {
		t.Fatalf("eventTime = %q, want 2026-10-12T09:00:00.000Z", resp.Referrers[0].EventTime)
	}
	if resp.CommentReferrers.Count != 1 {
		t.Fatalf("commentReferrers.count = %d, want 1", resp.CommentReferrers.Count)
	}
}

func TestReferencesReturns404ForMissingEvent(t *testing.T) {
	h := newHarness(t)

	rec := h.do("/api/events/999/references")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body.String())
	}
	// 404 形状冻结：只有 {error}，没有 code。
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "Event not found" || len(body) != 1 {
		t.Fatalf("body = %s, want {\"error\":\"Event not found\"}", rec.Body.String())
	}
}

// route.ts 用 parseInt 解析路径 id：NaN → 400 {error:'Invalid event ID'}（同样没有
// code）；带尾随垃圾的数字按前缀解析（'/12abc' 就是 12）；0x 前缀按十六进制。
func TestReferencesParsesIDLikeParseInt(t *testing.T) {
	t.Run("non-numeric id is 400", func(t *testing.T) {
		h := newHarness(t)

		rec := h.do("/api/events/abc/references")

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["error"] != "Invalid event ID" || len(body) != 1 {
			t.Fatalf("body = %s, want {\"error\":\"Invalid event ID\"}", rec.Body.String())
		}
	})

	t.Run("trailing garbage parses as prefix", func(t *testing.T) {
		h := newHarness(t)
		eventID := h.seedEvent("Target event")
		if eventID != 1 {
			t.Fatalf("first seeded event id = %d, want 1", eventID)
		}

		rec := h.do("/api/events/1abc/references")

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("hex prefix parses as base 16", func(t *testing.T) {
		h := newHarness(t)
		h.seedEvent("first")  // id 1
		h.seedEvent("second") // id 2
		rec := h.do("/api/events/0x2/references")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
		}
		resp := decodeReferences(t, rec.Body.Bytes())
		if resp.Referrers == nil {
			t.Fatalf("body = %s", rec.Body.String())
		}
	})
}

// 悬挂引用：event_references 行指向不存在的事件时，内连接丢弃它（ADR-0016：
// 消费方只统计能关联到现存事件的行）。内容文本照旧保留在引用方事件里。
func TestReferencesDropsDanglingEventReferences(t *testing.T) {
	h := newHarness(t)
	targetID := h.seedEvent("Target event")
	referrerID := h.seedEvent("Mentions a deleted event")
	if _, err := h.sqlDB.Exec(
		`INSERT INTO event_references (event_id, referenced_event_id, created_at) VALUES (?, 123456, ?)`,
		referrerID, seedCreatedAt,
	); err != nil {
		t.Fatalf("seed dangling reference: %v", err)
	}

	rec := h.do("/api/events/" + itoa(targetID) + "/references")
	resp := decodeReferences(t, rec.Body.Bytes())

	if len(resp.Referrers) != 0 {
		t.Fatalf("referrers = %+v, want none (dangling rows are dropped)", resp.Referrers)
	}
}

// findCommentReferrers 的排序是 asc(createdAt), asc(id)：先写「较新」的评论（id 小），
// 再写「较旧」的评论（id 大），返回顺序必须按 createdAt 升序 = 较旧在前。
func TestReferencesOrdersCommentsOldestFirst(t *testing.T) {
	h := newHarness(t)
	eventID := h.seedEvent("Target event")
	itemID := h.seedPlanItem("month", "2026-10-01", "2026-10-31", strPtr("2026-10"))
	// id 10 较新，id 20 较旧：若按 id 排序会得到 [10, 20]，按 createdAt 才是 [20, 10]。
	for _, c := range []struct {
		id        int64
		content   string
		createdAt int64
	}{
		{10, "newer @" + itoa(eventID), seedCreatedAt},
		{20, "older @" + itoa(eventID), seedCreatedAt - 100},
	} {
		if _, err := h.sqlDB.Exec(
			`INSERT INTO plan_item_comments (id, plan_item_id, content, author, created_at) VALUES (?, ?, ?, NULL, ?)`,
			c.id, itemID, c.content, c.createdAt,
		); err != nil {
			t.Fatalf("seed comment %d: %v", c.id, err)
		}
		if _, err := h.sqlDB.Exec(
			`INSERT INTO comment_references (comment_id, referenced_event_id, created_at) VALUES (?, ?, ?)`,
			c.id, eventID, seedCreatedAt,
		); err != nil {
			t.Fatalf("seed citation %d: %v", c.id, err)
		}
	}

	rec := h.do("/api/events/" + itoa(eventID) + "/references")
	resp := decodeReferences(t, rec.Body.Bytes())

	if len(resp.CommentReferrers.Comments) != 2 {
		t.Fatalf("comments = %+v, want 2", resp.CommentReferrers.Comments)
	}
	if resp.CommentReferrers.Comments[0].CommentID != 20 || resp.CommentReferrers.Comments[1].CommentID != 10 {
		t.Fatalf("comments = %+v, want ids [20 10] (createdAt asc)", resp.CommentReferrers.Comments)
	}
	if resp.CommentReferrers.Comments[0].Scope != "month" || resp.CommentReferrers.Comments[0].MonthKey == nil ||
		*resp.CommentReferrers.Comments[0].MonthKey != "2026-10" {
		t.Fatalf("month comment = %+v, want scope month + monthKey 2026-10", resp.CommentReferrers.Comments[0])
	}
}

// 数据库故障落在 route.ts 的 catch：500 + {error, code}。
func TestReferencesDatabaseErrorReturns500(t *testing.T) {
	h := newHarness(t)
	h.seedEvent("Target event")
	if err := h.sqlDB.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	rec := h.do("/api/events/1/references")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error != "Failed to fetch referrers" || body.Code != "FETCH_REFERRERS_ERROR" {
		t.Fatalf("body = %s, want FETCH_REFERRERS_ERROR shape", rec.Body.String())
	}
}
