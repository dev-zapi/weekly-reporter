package engine

import (
	"bytes"
	"encoding/json"
	"strings"
)

// NDJSON 线事件：10 种 type 与字段名必须与 src/lib/generation/stream.ts 的
// GenerationStreamEvent 逐字一致（客户端逐行 JSON.parse，冻结不变量）。
type WireEvent struct {
	Type string `json:"type"`
	// start
	TurnID   *int64  `json:"turnId,omitempty"`
	Protocol *string `json:"protocol,omitempty"`
	Model    *string `json:"model,omitempty"`
	// working
	Label *string `json:"label,omitempty"`
	// reasoning-delta / text-delta
	Text *string `json:"text,omitempty"`
	// tool-input-delta / tool-call / tool-result
	ToolName   *string `json:"toolName,omitempty"`
	ToolCallID *string `json:"toolCallId,omitempty"`
	// proposal
	Proposal *WireProposal `json:"proposal,omitempty"`
	// finish
	Status *string `json:"status,omitempty"`
	// error
	Message *string `json:"message,omitempty"`
}

// WireProposal 镜像 GenerationStreamProposal；createdAt 必须序列化成
// JS Date.toJSON() 的形态（UTC，固定 3 位毫秒）。
type WireProposal struct {
	ID              int64           `json:"id"`
	Content         string          `json:"content"`
	Summary         []string        `json:"summary"`
	Status          string          `json:"status"`
	SourceRevision  int64           `json:"sourceRevision"`
	CreatedAt       string          `json:"createdAt"`
	PublicSummary   json.RawMessage `json:"publicSummary"`
	BaselineContent *string         `json:"baselineContent"`
}

// jsonLine 序列化一行 NDJSON。SetEscapeHTML(false) 对齐 JSON.stringify
// （不转义 <,>,&）；Encoder.Encode 自带结尾换行。
func jsonLine(value any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return buffer.Bytes()
}

// marshalJSONText 复刻 JSON.stringify，返回落库用的文本（不转义 HTML）。
func marshalJSONText(value any) (string, bool) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", false
	}
	return strings.TrimSuffix(buffer.String(), "\n"), true
}
