-- B6 generation engine writes (blueprint 5 B6, ticket #110).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- Regular engine SQL stays in sqlc (ADR-0025). Sequence-number allocation
-- (max(sequence)+1 + insert) runs inside db.InImmediateTx, a BEGIN IMMEDIATE
-- transaction shared with the Next runtime, so two writers cannot pick the
-- same part sequence. JSON text columns are written with CAST(... AS TEXT) so
-- stored rows keep drizzle's TEXT storage class.
--
-- Query names carry a ForGenerationEngine suffix: sibling B6 tickets read the
-- same generation_* tables and would otherwise hit duplicate query names once
-- the batch branches merge.

-- name: GetGenerationSessionByIDForGenerationEngine :one
SELECT * FROM generation_sessions WHERE id = ? LIMIT 1;

-- name: InsertGenerationTurnForGenerationEngine :one
INSERT INTO generation_turns (session_id, status, protocol, model, reasoning_effort, created_at)
VALUES (?, 'working', ?, ?, NULL, ?)
RETURNING *;

-- name: GetGenerationTurnByIDForGenerationEngine :one
SELECT * FROM generation_turns WHERE id = ? LIMIT 1;

-- name: UpdateGenerationTurnFinishForGenerationEngine :one
UPDATE generation_turns
SET status = ?, error = ?, finished_at = ?
WHERE id = ?
RETURNING *;

-- name: UpdateGenerationSessionUpdatedAtForGenerationEngine :exec
UPDATE generation_sessions SET updated_at = ? WHERE id = ?;

-- name: UpdateGenerationMessagePartContentForGenerationEngine :exec
UPDATE generation_message_parts SET content = ? WHERE id = ?;

-- name: InsertGenerationProposalForGenerationEngine :one
INSERT INTO generation_proposals
  (session_id, turn_id, content, summary, source_revision, status, public_summary, baseline_content, created_at)
VALUES (sqlc.arg('session_id'), sqlc.arg('turn_id'), sqlc.arg('content'),
        CAST(sqlc.arg('summary') AS TEXT), sqlc.arg('source_revision'), 'pending',
        CAST(sqlc.narg('public_summary') AS TEXT), sqlc.arg('baseline_content'), sqlc.arg('created_at'))
RETURNING id;

-- name: SupersedePendingProposalsForGenerationEngine :exec
UPDATE generation_proposals
SET status = 'superseded'
WHERE session_id = ? AND status = 'pending';

-- name: GetGenerationProposalByTurnForGenerationEngine :one
SELECT id FROM generation_proposals WHERE turn_id = ? LIMIT 1;

-- One projection backs the accept route (by id + session) and keeps the JSON
-- columns scan-friendly (same CAST AS BLOB rule as queries/reports.sql).
-- name: GetGenerationProposalByIDForGenerationEngine :one
SELECT id, session_id, turn_id, content, CAST(summary AS BLOB) AS summary, source_revision, status,
       CAST(plan_state AS BLOB) AS plan_state, CAST(public_summary AS BLOB) AS public_summary,
       baseline_content, created_at, accepted_at
FROM generation_proposals
WHERE id = sqlc.arg('id') AND session_id = sqlc.arg('session_id')
LIMIT 1;

-- name: UpdateGenerationProposalAcceptedForGenerationEngine :exec
UPDATE generation_proposals
SET status = 'accepted', accepted_at = ?
WHERE id = ?;

-- name: InsertGenerationQuerySnapshotForGenerationEngine :one
INSERT INTO generation_query_snapshots
  (session_id, tool_name, parameters, called_at, source_report_id, source_audience,
   source_updated_at, source_week_start, source_week_end, source_final_status,
   result, result_count, truncated, duration_ms, error_code, trigger, previous_snapshot_id, created_at)
VALUES (sqlc.arg('session_id'), sqlc.arg('tool_name'), CAST(sqlc.arg('parameters') AS TEXT),
        sqlc.arg('called_at'), sqlc.arg('source_report_id'), sqlc.arg('source_audience'),
        sqlc.narg('source_updated_at'), sqlc.narg('source_week_start'), sqlc.narg('source_week_end'),
        sqlc.narg('source_final_status'), CAST(sqlc.arg('result') AS TEXT), sqlc.arg('result_count'),
        sqlc.arg('truncated'), sqlc.arg('duration_ms'), sqlc.narg('error_code'), sqlc.arg('trigger'),
        sqlc.narg('previous_snapshot_id'), sqlc.arg('created_at'))
RETURNING id;

-- name: GetGenerationQuerySnapshotByIDForGenerationEngine :one
SELECT id, session_id, tool_name, CAST(parameters AS BLOB) AS parameters, called_at, source_report_id,
       source_audience, source_updated_at, source_week_start, source_week_end, source_final_status,
       CAST(result AS BLOB) AS result, result_count, truncated, duration_ms, error_code, "trigger",
       previous_snapshot_id, created_at
FROM generation_query_snapshots
WHERE id = sqlc.arg('id') AND session_id = sqlc.arg('session_id')
LIMIT 1;

-- name: GetLatestQuerySnapshotForToolForGenerationEngine :one
SELECT id FROM generation_query_snapshots
WHERE session_id = ? AND tool_name = ?
ORDER BY id DESC
LIMIT 1;

-- Accept-proposal variant rewrite (service.ts acceptGenerationProposal).
-- name: UpdateReportVariantAcceptedForGenerationEngine :exec
UPDATE report_variants
SET final_content = ?, final_status = 'current', template_id = ?, template_name = ?,
    template_content = ?, ai_style = ?, accepted_proposal_id = ?, updated_at = ?
WHERE id = ?;
