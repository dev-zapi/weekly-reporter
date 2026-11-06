-- B5 settings/ai domain (ticket #105), the ai_config single-row config surface.
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- model_list_cache is a drizzle mode:'json' column holding JSON *text*. Reads
-- CAST it to BLOB so Go can scan it (same finding as queries/events.sql); the
-- write path is hand-written in ai_config_native.go so the stored value stays
-- TEXT (the Next runtime keeps reading this database until cutover, and sqlc
-- would type the parameter as json.RawMessage, i.e. bind it as a BLOB).
--
-- Query names carry a ForSettings suffix: the B5 ai/* one-shots read the same
-- ai_config row from a sibling ticket, and a duplicate sqlc name aborts the
-- generated package.

-- name: GetAIConfigForSettings :one
SELECT id, protocol, api_url, api_key, model,
       CAST(model_list_cache AS BLOB) AS model_list_cache,
       model_list_cached_at, created_at, updated_at
FROM ai_config
LIMIT 1;

-- name: UpdateAIConfigForSettings :one
UPDATE ai_config
SET protocol = ?, api_url = ?, api_key = ?, model = ?, updated_at = ?
WHERE id = ?
RETURNING id, protocol, api_url, api_key, model,
          CAST(model_list_cache AS BLOB) AS model_list_cache,
          model_list_cached_at, created_at, updated_at;

-- name: InsertAIConfigForSettings :one
INSERT INTO ai_config (protocol, api_url, api_key, model, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING id, protocol, api_url, api_key, model,
          CAST(model_list_cache AS BLOB) AS model_list_cache,
          model_list_cached_at, created_at, updated_at;

-- name: DeleteAIConfigForSettings :exec
DELETE FROM ai_config;
