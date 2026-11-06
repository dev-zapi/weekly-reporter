-- B2 events domain queries (blueprint 5 B2).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- JSON text columns must be CAST(... AS BLOB) on every read path: drizzle stored
-- them as SQLite TEXT, and Go can only scan BLOB into the JSON-typed fields
-- (finding recorded in queries/common.sql, decided here for the events domain).

-- name: GetRawEvent :one
SELECT id, event_time, source, content, CAST(metadata AS BLOB) AS metadata, category, created_at, updated_at, is_important
FROM raw_events
WHERE id = ?
LIMIT 1;

-- ListEvents backs GET /api/events when no tag filter is active. Every condition
-- is a flag plus its values so one static statement mirrors the route's dynamic
-- WHERE:
--   * week_filter / date_filter mirror the two optional `between` conditions;
--   * source_eq mirrors `source = 'manual'`, source_ne mirrors `source != 'manual'`;
--   * cursor_filter mirrors the composite (event_time, id) cursor; cursor_id_filter
--     stays 0 when parseInt('cursorId') is NaN, which makes only the `id <` half
--     unusable (SQLite compares false against NaN, exactly like the route).
-- limit = -1 is SQLite's "no LIMIT clause" (drizzle drops the clause when the
-- computed limit is NaN or negative); the route re-applies the JS slice semantics.
-- The tag branch is hand-written native SQL (see events_native.go): the IN list
-- length varies per request, which sqlc's numbered placeholders cannot express.
-- name: ListEvents :many
SELECT id, event_time, source, content, CAST(metadata AS BLOB) AS metadata, category, created_at, updated_at, is_important,
       (SELECT COUNT(*) FROM comment_references WHERE comment_references.referenced_event_id = raw_events.id) AS comment_referrer_count
FROM raw_events
WHERE (sqlc.arg('week_filter') = 0 OR (raw_events.event_time >= sqlc.arg('week_start') AND raw_events.event_time <= sqlc.arg('week_end')))
  AND (sqlc.arg('date_filter') = 0 OR (raw_events.event_time >= sqlc.arg('date_start') AND raw_events.event_time <= sqlc.arg('date_end')))
  AND (sqlc.arg('source_eq_filter') = 0 OR raw_events.source = sqlc.arg('source_eq'))
  AND (sqlc.arg('source_ne_filter') = 0 OR raw_events.source <> sqlc.arg('source_ne'))
  AND (sqlc.arg('cursor_filter') = 0
       OR raw_events.event_time < sqlc.arg('cursor_time_lt')
       OR (raw_events.event_time = sqlc.arg('cursor_time_eq')
           AND sqlc.arg('cursor_id_filter') = 1
           AND raw_events.id < sqlc.arg('cursor_id')))
ORDER BY raw_events.event_time DESC
LIMIT sqlc.arg('limit');

-- UpdateRawEvent mirrors the route's dynamic drizzle update: only the fields
-- present in the body are rewritten, updated_at always is.
-- name: UpdateRawEvent :one
UPDATE raw_events
SET content = COALESCE(sqlc.narg('content'), content),
    event_time = COALESCE(sqlc.narg('event_time'), event_time),
    is_important = COALESCE(sqlc.narg('is_important'), is_important),
    updated_at = sqlc.arg('updated_at')
WHERE id = sqlc.arg('id')
RETURNING id, event_time, source, content, CAST(metadata AS BLOB) AS metadata, category, created_at, updated_at, is_important;

-- name: DeleteRawEvent :exec
DELETE FROM raw_events WHERE id = ?;

-- InsertManualRawEvent mirrors the POST insert: source manual, is_important
-- explicitly false, metadata/category left NULL. CAST on the RETURNING path for
-- the same JSON-column reason as GetRawEvent.
-- name: InsertManualRawEvent :one
INSERT INTO raw_events (event_time, source, content, is_important, created_at, updated_at)
VALUES (?, 'manual', ?, 0, ?, ?)
RETURNING id, event_time, source, content, CAST(metadata AS BLOB) AS metadata, category, created_at, updated_at, is_important;

-- name: ListEventTagNames :many
SELECT tag_name FROM event_tags WHERE event_id = ?;

-- name: DeleteEventTagsByEventID :exec
DELETE FROM event_tags WHERE event_id = ?;

-- deleteEventReferences removes both directions: rows written by this event and
-- rows pointing at it (ADR-0016 dangling-reference cleanup).
-- name: DeleteEventReferencesForEvent :exec
DELETE FROM event_references
WHERE event_id = sqlc.arg('event_id') OR referenced_event_id = sqlc.arg('event_id');

-- name: DeleteEventReferencesByEventID :exec
DELETE FROM event_references WHERE event_id = ?;

-- name: InsertEventReference :exec
INSERT INTO event_references (event_id, referenced_event_id, created_at) VALUES (?, ?, ?);

-- name: DeleteEventPlanReferencesByEventID :exec
DELETE FROM event_plan_references WHERE event_id = ?;

-- name: InsertEventPlanReference :exec
INSERT INTO event_plan_references (event_id, plan_item_id, created_at) VALUES (?, ?, ?);

-- name: DeleteCommentReferencesForEvent :exec
DELETE FROM comment_references WHERE referenced_event_id = ?;

-- Aliases are appended to each event's metadata in GET /api/events. config is a
-- JSON column stored as TEXT, hence the CAST on the read path.
-- name: ListCollectSourcesForAliases :many
SELECT id, CAST(config AS BLOB) AS config FROM collect_sources;
