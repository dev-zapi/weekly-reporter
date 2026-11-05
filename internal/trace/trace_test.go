package trace

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

const (
	incomingTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	incomingSpanID  = "00f067aa0ba902b7"
)

func TestParseIncomingTraceID(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    string
		wantOK  bool
	}{
		{
			name:    "traceparent wins",
			headers: map[string]string{"traceparent": "00-" + incomingTraceID + "-" + incomingSpanID + "-01"},
			want:    incomingTraceID,
			wantOK:  true,
		},
		{
			name:    "invalid traceparent falls through to b3",
			headers: map[string]string{"traceparent": "ff-" + incomingTraceID + "-" + incomingSpanID + "-01", "x-b3-traceid": "b3b3b3b3b3b3b3b3"},
			want:    "0000000000000000b3b3b3b3b3b3b3b3",
			wantOK:  true,
		},
		{
			name:    "uppercase traceparent is rejected",
			headers: map[string]string{"traceparent": "00-" + "4BF92F3577B34DA6A3CE929D0E0E4736" + "-" + incomingSpanID + "-01", "x-trace-id": "a" + incomingTraceID[1:]},
			want:    "a" + incomingTraceID[1:],
			wantOK:  true,
		},
		{
			name:    "zero trace id is rejected",
			headers: map[string]string{"x-trace-id": zeroTraceID},
			wantOK:  false,
		},
		{
			name:    "b3 64-bit id is left padded",
			headers: map[string]string{"x-b3-traceid": "4bf92f3577b34da6"},
			want:    "00000000000000004bf92f3577b34da6",
			wantOK:  true,
		},
		{
			name:    "legacy x-trace-id accepted last",
			headers: map[string]string{"x-trace-id": incomingTraceID},
			want:    incomingTraceID,
			wantOK:  true,
		},
		{
			name:    "nothing valid",
			headers: map[string]string{"x-trace-id": "not-hex"},
			wantOK:  false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := http.Header{}
			for k, v := range tt.headers {
				h.Set(k, v)
			}
			got, ok := ParseIncomingTraceID(h)
			if ok != tt.wantOK || got != tt.want {
				t.Fatalf("ParseIncomingTraceID() = (%q, %v), want (%q, %v)", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestGeneratedIDsAreValid(t *testing.T) {
	for i := 0; i < 100; i++ {
		traceID := NewTraceID()
		if !isValidTraceID(traceID) {
			t.Fatalf("NewTraceID() = %q, invalid", traceID)
		}
		spanID := NewSpanID()
		if !isValidSpanID(spanID) {
			t.Fatalf("NewSpanID() = %q, invalid", spanID)
		}
	}
}

func TestMiddlewareSetsTraceHeaders(t *testing.T) {
	var seen Context
	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, _ = FromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/events", nil))

	if !isValidTraceID(rec.Header().Get(headerTraceID)) {
		t.Fatalf("x-trace-id = %q", rec.Header().Get(headerTraceID))
	}
	if !isValidSpanID(rec.Header().Get(headerSpanID)) {
		t.Fatalf("x-span-id = %q", rec.Header().Get(headerSpanID))
	}
	want := "00-" + rec.Header().Get(headerTraceID) + "-" + rec.Header().Get(headerSpanID) + "-01"
	if got := rec.Header().Get(headerTraceParent); got != want {
		t.Fatalf("traceparent = %q, want %q", got, want)
	}
	if seen.TraceID != rec.Header().Get(headerTraceID) || seen.SpanID != rec.Header().Get(headerSpanID) {
		t.Fatalf("handler context = %+v, response headers disagree", seen)
	}
}

func TestMiddlewareInheritsInboundTraceIDWithFreshSpan(t *testing.T) {
	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, ok := FromContext(r.Context())
		if !ok {
			t.Fatalf("missing trace context")
		}
		if ctx.TraceID != incomingTraceID {
			t.Fatalf("trace id = %q, want inherited %q", ctx.TraceID, incomingTraceID)
		}
		if ctx.SpanID == incomingSpanID {
			t.Fatalf("span id must be fresh, got inbound value")
		}
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/events", nil)
	req.Header.Set("traceparent", "00-"+incomingTraceID+"-"+incomingSpanID+"-01")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get(headerTraceID); got != incomingTraceID {
		t.Fatalf("response x-trace-id = %q, want %q", got, incomingTraceID)
	}
}

func TestMiddlewareKeepsHeadersOnEarlyResponse(t *testing.T) {
	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"Unauthorized"}`, http.StatusUnauthorized)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/events", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get(headerTraceID) == "" || rec.Header().Get(headerTraceParent) == "" {
		t.Fatalf("trace headers missing on 401: %v", rec.Header())
	}
}

func TestNestedContextIsNotReplaced(t *testing.T) {
	root := Context{TraceID: incomingTraceID, SpanID: incomingSpanID}
	ctx := WithContext(context.Background(), root)

	got, ok := FromContext(ctx)
	if !ok || got != root {
		t.Fatalf("FromContext() = (%+v, %v)", got, ok)
	}
}
