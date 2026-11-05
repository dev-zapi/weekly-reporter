-- B1 auth and audit domain queries (blueprint 5 B1).
-- ASCII-only comments on purpose: sqlc's "edited query" re-parse mis-indexes byte
-- offsets after a multibyte comment and garbles the following statement
-- (reproduced in B0, see queries/common.sql).

-- name: InsertAPIToken :one
INSERT INTO api_tokens (name, token_hash, prefix, created_at, last_used_at, expires_at, revoked_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING id, name, prefix, created_at, last_used_at, expires_at, revoked_at;

-- name: FindAPITokenByID :one
SELECT id, name, token_hash, prefix, created_at, last_used_at, expires_at, revoked_at
FROM api_tokens
WHERE id = ?
LIMIT 1;

-- name: ListAPITokens :many
SELECT id, name, prefix, created_at, last_used_at, expires_at, revoked_at
FROM api_tokens
ORDER BY created_at DESC, id DESC;

-- Revoke keeps the row (audit trail) and is idempotent: a second call matches 0 rows
-- so the original revoked_at timestamp survives.
-- name: RevokeAPIToken :execrows
UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL;

-- Audit filters are optional: a NULL named arg means "condition omitted", matching
-- the route's dynamic WHERE (invalid values are silently ignored upstream).
-- name: ListAuditLogs :many
SELECT id, created_at, pat_name, method, api_path, status, user_agent, agent_identity, caller_cwd, outcome
FROM api_audit_log
WHERE (sqlc.narg('pat_name') IS NULL OR pat_name = sqlc.narg('pat_name'))
  AND (sqlc.narg('status') IS NULL OR status = sqlc.narg('status'))
  AND (sqlc.narg('outcome') IS NULL OR outcome = sqlc.narg('outcome'))
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountAuditLogs :one
SELECT COUNT(*)
FROM api_audit_log
WHERE (sqlc.narg('pat_name') IS NULL OR pat_name = sqlc.narg('pat_name'))
  AND (sqlc.narg('status') IS NULL OR status = sqlc.narg('status'))
  AND (sqlc.narg('outcome') IS NULL OR outcome = sqlc.narg('outcome'));
