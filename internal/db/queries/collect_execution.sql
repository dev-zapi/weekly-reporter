-- B4 collect execution queries (git-local fetch / git-remote sync).
-- ASCII-only comments on purpose: sqlc's edited-query re-parse mis-indexes byte
-- offsets after a multibyte comment (see queries/common.sql).
--
-- config is a JSON text column: like the events domain, every read path casts it
-- to BLOB so it scans into json.RawMessage, and every write path casts the bound
-- value back to TEXT so SQLite stores it with TEXT affinity (drizzle does the
-- same with JSON.stringify).

-- name: GetCollectSource :one
SELECT id, type, name, CAST(config AS BLOB) AS config, enabled, last_sync_at, last_sync_status, created_at, updated_at, status, project_scope
FROM collect_sources
WHERE id = ?
LIMIT 1;

-- name: ListEnabledCollectSources :many
SELECT id, type, name, CAST(config AS BLOB) AS config, enabled, last_sync_at, last_sync_status, created_at, updated_at, status, project_scope
FROM collect_sources
WHERE status = 'enabled'
ORDER BY id;

-- UpdateCollectSource mirrors the sync engine's partial drizzle updates: only the
-- listed fields are rewritten, updated_at always is. sqlc.narg keeps "absent"
-- (NULL) distinct from a real value.
-- name: UpdateCollectSource :exec
UPDATE collect_sources
SET config = COALESCE(CAST(sqlc.narg('config') AS TEXT), config),
    status = COALESCE(sqlc.narg('status'), status),
    last_sync_at = COALESCE(sqlc.narg('last_sync_at'), last_sync_at),
    last_sync_status = COALESCE(sqlc.narg('last_sync_status'), last_sync_status),
    updated_at = sqlc.arg('updated_at')
WHERE id = sqlc.arg('id');

-- The sync engine reads metadata only to collect the existing sha set for
-- sourceId dedup (src/lib/collect/sync.ts insertNewEvents).
-- name: ListRawEventMetadataBySourceID :many
SELECT CAST(metadata AS BLOB) AS metadata
FROM raw_events
WHERE json_extract(metadata, '$.sourceId') = CAST(sqlc.arg('source_id') AS INTEGER);

-- metadata is cast back to TEXT so the row lands with the same storage class
-- drizzle writes (JSON.stringify -> TEXT), not the BLOB modernc would bind from
-- a []byte parameter.
-- name: InsertCollectedRawEvent :exec
INSERT INTO raw_events (event_time, source, content, metadata, category, created_at, updated_at)
VALUES (sqlc.arg('event_time'), sqlc.arg('source'), sqlc.arg('content'), CAST(sqlc.arg('metadata') AS TEXT), sqlc.arg('category'), sqlc.arg('created_at'), sqlc.arg('updated_at'));
