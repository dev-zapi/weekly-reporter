-- B5 prompts domain queries (blueprint 5 B5, ticket #104).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- Query names carry a ForPromptRoutes suffix for the same reason as
-- queries/templates.sql: the AI one-shot ticket reads ai_styles and
-- system_prompts too, and the B6 engine reads system prompts by key.

-- name: ListAIStylesForPromptRoutes :many
SELECT * FROM ai_styles
ORDER BY created_at ASC;

-- name: GetAIStyleForPromptRoutes :one
SELECT * FROM ai_styles
WHERE id = ?
LIMIT 1;

-- name: CountAIStylesForPromptRoutes :one
SELECT COUNT(*) FROM ai_styles;

-- name: InsertAIStyleForPromptRoutes :one
INSERT INTO ai_styles (key, label, system_prompt, temperature, detail_level, result_oriented, is_default, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- PUT /prompts/styles/{id}: updateAIStyle writes `input.x !== undefined ? input.x
-- : existing.x` for every column, so an absent key keeps the stored value.
-- COALESCE(narg) is that rule; the zod schema rejects null for the two nullable
-- columns, so "clear the column" is not a reachable request either.
-- name: UpdateAIStyleForPromptRoutes :one
UPDATE ai_styles
SET key = COALESCE(sqlc.narg('key'), key),
    label = COALESCE(sqlc.narg('label'), label),
    system_prompt = COALESCE(sqlc.narg('system_prompt'), system_prompt),
    temperature = COALESCE(sqlc.narg('temperature'), temperature),
    detail_level = COALESCE(sqlc.narg('detail_level'), detail_level),
    result_oriented = COALESCE(sqlc.narg('result_oriented'), result_oriented),
    is_default = COALESCE(sqlc.narg('is_default'), is_default),
    updated_at = sqlc.arg('updated_at')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DeleteAIStyleForPromptRoutes :exec
DELETE FROM ai_styles WHERE id = ?;

-- clear-others half of setDefaultStyle: drizzle's update() without where.
-- name: ClearAIStyleDefaultsForPromptRoutes :exec
UPDATE ai_styles SET is_default = false, updated_at = ?;

-- name: SetAIStyleDefaultForPromptRoutes :exec
UPDATE ai_styles SET is_default = true, updated_at = ? WHERE id = ?;

-- deleteAIStyle clears the references before deleting the style row.
-- name: ClearReportStyleOverrideForPromptRoutes :exec
UPDATE reports SET ai_style_override = NULL WHERE ai_style_override = ?;

-- name: ResetTemplateStyleForPromptRoutes :exec
UPDATE templates SET ai_style = 'formal', updated_at = ? WHERE ai_style = ?;

-- name: ListSystemPromptsForPromptRoutes :many
SELECT * FROM system_prompts
ORDER BY key ASC;

-- name: GetSystemPromptForPromptRoutes :one
SELECT * FROM system_prompts
WHERE key = ?
LIMIT 1;

-- name: InsertSystemPromptForPromptRoutes :one
INSERT INTO system_prompts (key, label, prompt_text, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
RETURNING *;

-- name: UpdateSystemPromptForPromptRoutes :one
UPDATE system_prompts
SET prompt_text = ?, updated_at = ?
WHERE key = ?
RETURNING *;
