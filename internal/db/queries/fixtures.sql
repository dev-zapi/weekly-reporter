-- B6 e2e fixtures route queries (blueprint 5 B6, ADR-0029).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- The fixtures route writes report/generation rows straight into the schema so
-- the e2e suite can seed and dispose deterministic data. Every name carries a
-- ForFixtures suffix: sibling B6 tickets consume the same tables and would
-- otherwise hit duplicate query names once the batch branches merge.
--
-- report_variants and the generation_* tables are written/deleted here only;
-- reads stay in the domain packages (the route never reads variants back).

-- The report row itself is inserted through common.sql's InsertReport: the
-- fixtures route writes the same columns (ai_style_override stays NULL), so a
-- second identical statement would only be a naming hazard for sibling tickets.

-- name: GetReportWeekStartForFixtures :one
SELECT week_start FROM reports WHERE id = ? LIMIT 1;

-- name: InsertReportVariantForFixtures :exec
INSERT INTO report_variants (report_id, variant, source_draft, final_content, final_status, accepted_proposal_id, source_revision, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- The cleanup walks one report id list twice: once to find the sessions whose
-- children must go, once to drop the sessions themselves.
-- name: ListGenerationSessionIDsForFixtures :many
SELECT id FROM generation_sessions WHERE report_id IN (sqlc.slice('report_ids'));

-- name: DeleteGenerationProposalsForFixtures :exec
DELETE FROM generation_proposals WHERE session_id = ?;

-- name: DeleteGenerationPlanJudgmentsForFixtures :exec
DELETE FROM generation_plan_judgments WHERE session_id = ?;

-- name: DeleteGenerationPlanOverridesForFixtures :exec
DELETE FROM generation_plan_overrides WHERE session_id = ?;

-- name: DeleteGenerationMessagePartsForFixtures :exec
DELETE FROM generation_message_parts WHERE session_id = ?;

-- name: DeleteGenerationTurnsForFixtures :exec
DELETE FROM generation_turns WHERE session_id = ?;

-- name: DeleteGenerationSessionsForFixtures :exec
DELETE FROM generation_sessions WHERE report_id IN (sqlc.slice('report_ids'));

-- name: DeleteReportEventSnapshotsForFixtures :exec
DELETE FROM report_event_snapshots WHERE report_id IN (sqlc.slice('report_ids'));

-- name: DeleteReportVariantsForFixtures :exec
DELETE FROM report_variants WHERE report_id IN (sqlc.slice('report_ids'));

-- name: DeleteReportsForFixtures :exec
DELETE FROM reports WHERE id IN (sqlc.slice('report_ids'));

-- name: DeleteRawEventsForFixtures :exec
DELETE FROM raw_events WHERE id IN (sqlc.slice('event_ids'));
