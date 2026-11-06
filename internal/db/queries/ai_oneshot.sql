-- B5 ai one-shot queries (ticket #106).
-- Query names carry a "ForAI" qualifier: the B5 sibling tickets also touch
-- ai_config / ai_styles / templates, and sqlc rejects duplicate query names
-- at integration time. ASCII-only comments: see queries/common.sql.
--
-- The one-shot routes read (never write) ai_config and ai_styles; the only
-- write here is the builtin-style seed that mirrors src/lib/ai/seed.ts
-- (ensureSeed seeds when ai_styles is empty).

-- name: GetAIConfigForAI :one
SELECT id, protocol, api_url, api_key, model
FROM ai_config
LIMIT 1;

-- name: GetAIStyleByKeyForAI :one
SELECT id, key, label, system_prompt, temperature, detail_level, result_oriented, is_default, created_at, updated_at
FROM ai_styles
WHERE key = ?
LIMIT 1;

-- name: GetDefaultAIStyleForAI :one
SELECT id, key, label, system_prompt, temperature, detail_level, result_oriented, is_default, created_at, updated_at
FROM ai_styles
WHERE is_default = 1
LIMIT 1;

-- name: GetTemplateAIStyleForAI :one
SELECT ai_style
FROM templates
WHERE id = ?
LIMIT 1;

-- name: CountAIStylesForAI :one
SELECT count(*)
FROM ai_styles;

-- name: InsertAIStyleForAI :exec
INSERT INTO ai_styles (key, label, system_prompt, temperature, detail_level, result_oriented, is_default, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO NOTHING;
