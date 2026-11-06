-- B2 tags domain queries (blueprint 5 B2).
-- ASCII-only comments on purpose: sqlc's "edited query" re-parse mis-indexes byte
-- offsets after a multibyte comment and garbles the following statement
-- (reproduced in B0, see queries/common.sql).

-- name: ListTagsWithCounts :many
SELECT tag_name AS name, COUNT(*) AS tag_count
FROM event_tags
GROUP BY tag_name
ORDER BY tag_name ASC;

-- name: CountEventTagsByTagName :one
SELECT COUNT(*) FROM event_tags WHERE tag_name = ?;

-- name: ListEventIDsByTagName :many
SELECT event_id FROM event_tags WHERE tag_name = ?;

-- name: DeleteEventTagsByTagName :exec
DELETE FROM event_tags WHERE tag_name = ?;

-- Delete the old-name rows only for events that already carry the new name
-- (the TS rename's "overlap set"). Keeping the new-name row is what makes the
-- rename a merge instead of a unique-index violation.
-- name: DeleteOverlappingEventTags :exec
DELETE FROM event_tags
WHERE event_tags.tag_name = sqlc.arg('old_name')
  AND event_tags.event_id IN (SELECT old_rows.event_id FROM event_tags AS old_rows WHERE old_rows.tag_name = sqlc.arg('new_name'));

-- Rename the rows left after DeleteOverlappingEventTags. Those are exactly the
-- TS "renameIds" (old-name rows whose event is not in the merge set).
-- name: RenameEventTags :exec
UPDATE event_tags SET tag_name = sqlc.arg('new_name') WHERE event_tags.tag_name = sqlc.arg('old_name');

-- Count the events carrying both names: drizzle's "overlap set". It decides both
-- the merged flag and whether the old-name rows must be deleted (rather than renamed)
-- to survive the (event_id, tag_name) unique index.
-- name: CountOverlappingEventTags :one
SELECT COUNT(*)
FROM event_tags AS old_rows
WHERE old_rows.tag_name = sqlc.arg('old_name')
  AND EXISTS (
    SELECT 1 FROM event_tags AS new_rows
    WHERE new_rows.event_id = old_rows.event_id AND new_rows.tag_name = sqlc.arg('new_name'));

-- Events that currently carry a tag, read before the tag rows are mutated; the
-- route rewrites their content to keep the ADR-0012 dual storage consistent.
-- name: ListEventsByTagName :many
SELECT raw_events.id, raw_events.content
FROM raw_events
WHERE raw_events.id IN (SELECT event_id FROM event_tags WHERE tag_name = ?);

-- name: UpdateRawEventContent :exec
UPDATE raw_events SET content = ? WHERE id = ?;
