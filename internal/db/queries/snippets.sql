-- B2 snippets domain queries (blueprint 5 B2).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.

-- name: ListSentenceSnippets :many
SELECT id, content, category, is_built_in, created_at, updated_at
FROM sentence_snippets;

-- name: ListSentenceSnippetsByCategory :many
SELECT id, content, category, is_built_in, created_at, updated_at
FROM sentence_snippets
WHERE category = ?;

-- name: GetSentenceSnippet :one
SELECT id, content, category, is_built_in, created_at, updated_at
FROM sentence_snippets
WHERE id = ?
LIMIT 1;

-- name: InsertSentenceSnippet :one
INSERT INTO sentence_snippets (content, category, is_built_in, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
RETURNING id, content, category, is_built_in, created_at, updated_at;

-- name: DeleteSentenceSnippet :exec
DELETE FROM sentence_snippets WHERE id = ?;
