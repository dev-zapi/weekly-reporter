-- B6 reports domain queries (blueprint 5 B6, ticket #107).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- Query names carry a ForReportRoutes suffix: the B6 batch has six parallel
-- tickets that read the same reports / report_variants / generation_* tables
-- (query tools #108, engine #110, fixtures #111), and sqlc rejects duplicate
-- query names at integration time. See queries/templates.sql for the precedent.
--
-- JSON text columns are drizzle mode:'json' columns: they hold JSON *text*.
-- Every read path CASTs them to BLOB so they scan into json.RawMessage, and
-- every write path CASTs the argument to TEXT so stored rows keep the TEXT
-- storage class drizzle itself writes.
--
-- Reports / generation_sessions / generation_turns have no JSON columns, so
-- their statements use SELECT * / RETURNING * and map onto the generated model
-- structs. Report variants, proposals, message parts, query snapshots and raw
-- events do have JSON columns; their reads are one consolidated projection per
-- table (filters as flags) so each table produces exactly one Row struct.

-- GET /api/reports pagination. limit = -1 reproduces drizzle's "LIMIT clause
-- dropped" case (typeof limit === 'number' && limit >= 0): SQLite's LIMIT -1
-- means no upper bound. offset 0 is the same as no OFFSET clause.
-- name: ListReportsForReportRoutes :many
SELECT * FROM reports
ORDER BY created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountReportsForReportRoutes :one
SELECT COUNT(*) FROM reports;

-- name: GetReportForReportRoutes :one
SELECT * FROM reports
WHERE id = ?
LIMIT 1;

-- name: UpdateReportTitleForReportRoutes :one
UPDATE reports
SET title = ?, updated_at = ?
WHERE id = ?
RETURNING *;

-- name: UpdateReportContentForReportRoutes :one
UPDATE reports
SET content = ?, updated_at = ?
WHERE id = ?
RETURNING *;

-- name: DeleteReportForReportRoutes :exec
DELETE FROM reports WHERE id = ?;

-- One projection backs GET /api/reports (all variants), the report bundle
-- (report_filter), and every by-id lookup (&the variant pick in Go, which is
-- rowid order + LIMIT 1 in SQL terms).
-- name: ListReportVariantsForReportRoutes :many
SELECT id, report_id, variant, source_draft, final_content, final_status, template_id, template_name,
       template_content, CAST(structure_completeness_rule AS BLOB) AS structure_completeness_rule,
       ai_style, accepted_proposal_id, source_revision, created_at, updated_at
FROM report_variants
WHERE (sqlc.arg('id_filter') = 0 OR id = sqlc.arg('id'))
  AND (sqlc.arg('report_filter') = 0 OR report_id = sqlc.arg('report_id'));

-- name: InsertReportVariantForReportRoutes :one
INSERT INTO report_variants (report_id, variant, source_draft, final_status, source_revision, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING id;

-- regenerate-source rewrites the draft/revision and marks a stale final.
-- name: UpdateReportVariantSourceForReportRoutes :exec
UPDATE report_variants
SET source_draft = ?, source_revision = ?, final_status = ?, updated_at = ?
WHERE id = ?;

-- PUT final's dynamic drizzle set(): the template snapshot columns and ai_style
-- are only rewritten when the route resolved them (absent keys keep the stored
-- value), hence COALESCE(narg). final_content/final_status/updated_at always
-- are. structure_completeness_rule is deliberately never written (ADR-0021).
-- name: UpdateReportVariantFinalForReportRoutes :exec
UPDATE report_variants
SET final_content = sqlc.arg('final_content'),
    final_status = 'current',
    updated_at = sqlc.arg('updated_at'),
    template_id = COALESCE(sqlc.narg('template_id'), template_id),
    template_name = COALESCE(sqlc.narg('template_name'), template_name),
    template_content = COALESCE(sqlc.narg('template_content'), template_content),
    ai_style = COALESCE(sqlc.narg('ai_style'), ai_style)
WHERE id = sqlc.arg('id');

-- name: DeleteReportVariantsByReportForReportRoutes :exec
DELETE FROM report_variants WHERE report_id = ?;

-- name: ListReportSnapshotsForReportRoutes :many
SELECT id, report_id, raw_event_id, event_time, source, content, CAST(metadata AS BLOB) AS metadata,
       project_scope, leadership_included, personal_included, source_revision, created_at
FROM report_event_snapshots
WHERE report_id = ? AND source_revision = ?;

-- name: InsertReportSnapshotForReportRoutes :exec
INSERT INTO report_event_snapshots (report_id, raw_event_id, event_time, source, content, metadata,
                                    project_scope, leadership_included, personal_included, source_revision, created_at)
VALUES (sqlc.arg('report_id'), sqlc.arg('raw_event_id'), sqlc.arg('event_time'), sqlc.arg('source'),
        sqlc.arg('content'), CAST(sqlc.narg('metadata') AS TEXT), sqlc.arg('project_scope'),
        sqlc.arg('leadership_included'), sqlc.arg('personal_included'), sqlc.arg('source_revision'),
        sqlc.arg('created_at'));

-- name: DeleteReportSnapshotsByReportForReportRoutes :exec
DELETE FROM report_event_snapshots WHERE report_id = ?;

-- findEventsForWeek: no ORDER BY in route.ts (db.select().from(rawEvents)); the
-- BETWEEN bounds are local-day seconds computed in the domain layer.
-- name: ListRawEventsBetweenForReportRoutes :many
SELECT id, event_time, source, content, CAST(metadata AS BLOB) AS metadata, category, created_at, updated_at, is_important
FROM raw_events
WHERE event_time BETWEEN ? AND ?;

-- getSourceScopes: collect_sources id -> project scope.
-- name: ListCollectSourceScopesForReportRoutes :many
SELECT id, project_scope FROM collect_sources;

-- ---- generation sessions (read face used by /reports/{id}/generation-sessions)

-- variant_filter = 0 means "no variant filter" (route.ts passes variant only
-- when it is leadership/personal).
-- name: ListGenerationSessionsForReportRoutes :many
SELECT * FROM generation_sessions
WHERE report_id = sqlc.arg('report_id')
  AND (sqlc.arg('variant_filter') = 0 OR variant = sqlc.arg('variant'))
ORDER BY updated_at DESC;

-- name: GetGenerationSessionForReportRoutes :one
SELECT * FROM generation_sessions
WHERE id = ? AND report_id = ?
LIMIT 1;

-- name: InsertGenerationSessionForReportRoutes :one
INSERT INTO generation_sessions (report_id, report_variant_id, variant, title, status, source_revision,
                                 source_draft_snapshot, source_overview, template_id, template_name,
                                 template_content, ai_style_key, ai_style_label, ai_style_prompt,
                                 temperature, system_prompt, tool_rules, plan_policy, baseline_final_content,
                                 carry_forward_snapshot, created_at, updated_at)
VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
RETURNING *;

-- name: UpdateGenerationSessionTitleForReportRoutes :one
UPDATE generation_sessions
SET title = ?, updated_at = ?
WHERE id = ? AND report_id = ?
RETURNING *;

-- name: ArchiveGenerationSessionForReportRoutes :one
UPDATE generation_sessions
SET status = 'archived', archived_at = ?, updated_at = ?
WHERE id = ? AND report_id = ?
RETURNING *;

-- final route's accepted-session baseline update (drizzle scopes by id only).
-- name: UpdateGenerationSessionBaselineForReportRoutes :exec
UPDATE generation_sessions
SET baseline_final_content = ?, updated_at = ?
WHERE id = ?;

-- name: DeleteGenerationSessionsByReportForReportRoutes :exec
DELETE FROM generation_sessions WHERE report_id = ?;

-- name: GetLatestGenerationTurnForReportRoutes :one
SELECT * FROM generation_turns
WHERE session_id = ?
ORDER BY id DESC
LIMIT 1;

-- name: ListGenerationTurnsForReportRoutes :many
SELECT * FROM generation_turns
WHERE session_id = ?
ORDER BY id ASC;

-- name: GetWorkingGenerationTurnForReportRoutes :one
SELECT * FROM generation_turns
WHERE session_id = ? AND status = 'working'
LIMIT 1;

-- name: DeleteGenerationTurnsByReportForReportRoutes :exec
DELETE FROM generation_turns
WHERE session_id IN (SELECT id FROM generation_sessions WHERE report_id = ?);

-- One projection backs the session list (latest proposal), the detail list
-- (all proposals) and the by-id lookup used by PUT final.
-- name: ListGenerationProposalsForReportRoutes :many
SELECT id, session_id, turn_id, content, CAST(summary AS BLOB) AS summary, source_revision, status,
       CAST(plan_state AS BLOB) AS plan_state, CAST(public_summary AS BLOB) AS public_summary,
       baseline_content, created_at, accepted_at
FROM generation_proposals
WHERE (sqlc.arg('id_filter') = 0 OR id = sqlc.arg('id'))
  AND (sqlc.arg('session_filter') = 0 OR session_id = sqlc.arg('session_id'))
ORDER BY id ASC;

-- Checks the accepted-audit guard of DELETE /api/reports/{id}.
-- name: GetAcceptedGenerationProposalIDForReportRoutes :one
SELECT generation_proposals.id
FROM generation_proposals
JOIN generation_sessions ON generation_sessions.id = generation_proposals.session_id
WHERE generation_sessions.report_id = ? AND generation_proposals.status = 'accepted'
LIMIT 1;

-- delete order mirrors DELETE /api/reports/{id}'s transaction; the two
-- deprecated plan tables are still cleaned up for historical rows (ADR-0021).
-- name: DeleteGenerationProposalsByReportForReportRoutes :exec
DELETE FROM generation_proposals
WHERE session_id IN (SELECT id FROM generation_sessions WHERE report_id = ?);

-- name: DeleteGenerationPlanJudgmentsByReportForReportRoutes :exec
DELETE FROM generation_plan_judgments
WHERE session_id IN (SELECT id FROM generation_sessions WHERE report_id = ?);

-- name: DeleteGenerationPlanOverridesByReportForReportRoutes :exec
DELETE FROM generation_plan_overrides
WHERE session_id IN (SELECT id FROM generation_sessions WHERE report_id = ?);

-- name: ListGenerationMessagePartsForReportRoutes :many
SELECT id, session_id, turn_id, sequence, role, part_type, content, CAST(data AS BLOB) AS data, created_at
FROM generation_message_parts
WHERE session_id = ?
ORDER BY sequence ASC;

-- name: GetLatestGenerationMessageSequenceForReportRoutes :one
SELECT sequence FROM generation_message_parts
WHERE session_id = ?
ORDER BY sequence DESC
LIMIT 1;

-- name: InsertGenerationMessagePartForReportRoutes :exec
INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, data, created_at)
VALUES (sqlc.arg('session_id'), sqlc.arg('turn_id'), sqlc.arg('sequence'), sqlc.arg('role'),
        sqlc.arg('part_type'), sqlc.arg('content'), CAST(sqlc.narg('data') AS TEXT), sqlc.arg('created_at'));

-- name: DeleteGenerationMessagePartsByReportForReportRoutes :exec
DELETE FROM generation_message_parts
WHERE session_id IN (SELECT id FROM generation_sessions WHERE report_id = ?);

-- name: ListGenerationQuerySnapshotsForReportRoutes :many
SELECT id, session_id, tool_name, CAST(parameters AS BLOB) AS parameters, called_at, source_report_id,
       source_audience, source_updated_at, source_week_start, source_week_end, source_final_status,
       CAST(result AS BLOB) AS result, result_count, truncated, duration_ms, error_code, "trigger",
       previous_snapshot_id, created_at
FROM generation_query_snapshots
WHERE session_id = ?
ORDER BY id ASC;
