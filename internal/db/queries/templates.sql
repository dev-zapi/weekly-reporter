-- B5 templates domain queries (blueprint 5 B5, ticket #104).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- Query names carry a ForTemplateRoutes suffix: sibling B5/B6 tickets read the
-- same templates table (the AI one-shots resolve a template by id, report
-- routes copy template fields into variants), and a bare GetTemplate would risk
-- a duplicate name at integration. The suffix names the consuming route family.

-- name: ListTemplatesForTemplateRoutes :many
SELECT * FROM templates;

-- name: GetTemplateForTemplateRoutes :one
SELECT * FROM templates
WHERE id = ?
LIMIT 1;

-- PUT's full path (and the style-only path reuses it: writing unchanged values
-- back is unobservable). description/tags are narg + COALESCE because drizzle's
-- update().set() omits keys whose value is undefined: an absent field keeps its
-- stored value while an empty string overwrites it.
-- name: UpdateTemplateForTemplateRoutes :one
UPDATE templates
SET name = sqlc.arg('name'),
    content = sqlc.arg('content'),
    description = COALESCE(sqlc.narg('description'), description),
    tags = COALESCE(sqlc.narg('tags'), tags),
    ai_style = sqlc.arg('ai_style'),
    updated_at = sqlc.arg('updated_at')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: InsertTemplateForTemplateRoutes :one
INSERT INTO templates (name, content, description, tags, source_template_id, ai_style, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: DeleteTemplateForTemplateRoutes :exec
DELETE FROM templates WHERE id = ?;
