-- B6 report query tools (blueprint 5 B6, ticket #108).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- These are the reads behind query_report_list / query_report_content. Every
-- query carries a ForQueryTools suffix: sibling B6 tickets (#107 reports
-- routes, #110 generation engine, #111 e2e fixtures) read the same reports /
-- report_variants / generation_sessions tables and would otherwise hit
-- duplicate query names once the batch branches merge.

-- name: GetGenerationSessionAudienceForQueryTools :one
SELECT report_id, variant FROM generation_sessions WHERE id = ? LIMIT 1;

-- name: GetReportWeekStartForQueryTools :one
SELECT week_start FROM reports WHERE id = ? LIMIT 1;

-- The tool's authorized audience list: adopted (accepted_proposal_id set)
-- finals of the session audience. Order mirrors drizzle's
-- orderBy(desc(weekEnd), desc(id)); the Go side re-sorts after appending
-- legacy rows, exactly like the TypeScript source.
-- name: ListAuthorizedReportVariantsForQueryTools :many
SELECT reports.id AS report_id,
       reports.title AS title,
       reports.week_start AS week_start,
       reports.week_end AS week_end,
       report_variants.variant AS audience,
       report_variants.final_status AS final_status,
       report_variants.final_content AS final_content,
       report_variants.updated_at AS updated_at
FROM report_variants
JOIN reports ON reports.id = report_variants.report_id
WHERE report_variants.variant = ?
  AND report_variants.final_status IN (sqlc.slice('statuses'))
  AND report_variants.final_content IS NOT NULL
  AND report_variants.accepted_proposal_id IS NOT NULL
ORDER BY reports.week_end DESC, reports.id DESC;

-- Legacy rows are reports without any audience variant record.
-- name: ListReportVariantReportIDsForQueryTools :many
SELECT DISTINCT report_id FROM report_variants;

-- name: ListReportsForQueryTools :many
SELECT id, title, week_start, week_end, content, updated_at
FROM reports
ORDER BY week_end DESC, id DESC;

-- name: GetReportForQueryTools :one
SELECT id, title, week_start, week_end, content, updated_at
FROM reports
WHERE id = ?
LIMIT 1;

-- name: GetReportVariantForQueryTools :one
SELECT * FROM report_variants WHERE report_id = ? AND variant = ? LIMIT 1;

-- Presence probe for "does this report have any modern variant row".
-- name: GetReportVariantIDForQueryTools :one
SELECT id FROM report_variants WHERE report_id = ? LIMIT 1;
