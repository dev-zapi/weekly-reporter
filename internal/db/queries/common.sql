-- B0 first batch of shared queries: the minimal representative set that proves the
-- sqlc recipe's hard points, not a full domain port (domains move in B1+).
--   * timestamps stay int64 (api_tokens/api_audit_log hold Unix *milliseconds*,
--     every other time column holds Unix seconds -- see research doc 1.2)
--   * nullable JSON columns become *json.RawMessage (ListRecentRawEvents.metadata)
--   * RETURNING / ON CONFLICT / :execrows each appear at least once
-- NOTE: comments in this file are ASCII-only on purpose. sqlc's "edited query"
-- re-parse mis-indexes byte offsets after a multibyte comment and garbles the
-- following statement (reproduced: "mismatched input 'eated_at'").
-- NOTE (B0 finding, must be decided before B1 domain reads): drizzle stored every
-- JSON column as SQLite TEXT; modernc hands TEXT back as a Go string, and
-- *json.RawMessage can only scan a []byte/BLOB value. Reading a legacy JSON row
-- therefore needs CAST(col AS BLOB) or a string scan. This query set is
-- read-only for the JSON hard point and does not settle that decision.

-- name: FindAPITokenByHash :one
SELECT id, name, token_hash, prefix, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE token_hash = ? LIMIT 1;

-- name: TouchAPIToken :execrows
UPDATE api_tokens SET last_used_at = ? WHERE id = ?;

-- name: InsertAuditLog :exec
INSERT INTO api_audit_log (created_at, pat_name, method, api_path, status, user_agent, agent_identity, caller_cwd, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: InsertReport :one
INSERT INTO reports (title, content, week_start, week_end, ai_style_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *;

-- name: InsertEventTag :exec
INSERT INTO event_tags (event_id, tag_name, created_at) VALUES (?, ?, ?) ON CONFLICT (event_id, tag_name) DO NOTHING;

-- name: InsertRawEvent :one
INSERT INTO raw_events (event_time, source, content, metadata, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *;

-- name: ListRecentRawEvents :many
SELECT id, event_time, source, content, metadata, category, is_important, created_at, updated_at FROM raw_events ORDER BY event_time DESC, id DESC LIMIT ?;
