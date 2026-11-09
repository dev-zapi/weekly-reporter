-- B4 collect-sources read path (blueprint 5 B4, ticket #103).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- The config column is a drizzle mode:'json' column: it holds JSON *text*, and the
-- Go JSON representation can only scan a BLOB, hence CAST(config AS BLOB) on every
-- read path (same finding as the events domain, queries/events.sql).
--
-- The write path is hand-written in collect_sources_native.go on purpose: sqlc
-- types the config parameter as json.RawMessage ([]byte), and database/sql would
-- bind that as a BLOB. drizzle wrote TEXT, and the Next runtime keeps reading this
-- same database until cutover, so writes must stay TEXT.

-- name: GetCollectSource :one
SELECT id, type, name, CAST(config AS BLOB) AS config, enabled, status, project_scope, last_sync_at, last_sync_status, created_at, updated_at
FROM collect_sources
WHERE id = sqlc.arg('id')
LIMIT 1;

-- name: ListCollectSources :many
SELECT id, type, name, CAST(config AS BLOB) AS config, enabled, status, project_scope, last_sync_at, last_sync_status, created_at, updated_at
FROM collect_sources
ORDER BY id ASC;

-- name: ListCollectSourcesByType :many
SELECT id, type, name, CAST(config AS BLOB) AS config, enabled, status, project_scope, last_sync_at, last_sync_status, created_at, updated_at
FROM collect_sources
WHERE type = sqlc.arg('type')
ORDER BY id ASC;

-- name: DeleteCollectSource :exec
DELETE FROM collect_sources WHERE id = sqlc.arg('id');
