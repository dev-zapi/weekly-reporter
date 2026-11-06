-- B3 plan-domain queries (blueprint 5 B3).
-- ASCII-only comments on purpose: see queries/common.sql for the sqlc finding.
--
-- The plan domain spans period_plans, period_plan_items, plan_item_comments,
-- comment_references and event_plan_references. Reads/writes here mirror
-- src/lib/plan-items.ts, src/lib/plan-references/* and
-- src/lib/plan-item-comments/db.ts one statement at a time.
--
-- Variable-length IN lists use sqlc.slice: the chain/child aggregations walk
-- lists whose length comes from data, which numbered placeholders cannot express.

-- name: GetPeriodPlan :one
SELECT id, scope, period_start, period_end, month_key, created_at, updated_at
FROM period_plans
WHERE id = ?
LIMIT 1;

-- name: GetPeriodPlanByPeriod :one
SELECT id, scope, period_start, period_end, month_key, created_at, updated_at
FROM period_plans
WHERE scope = ? AND period_start = ? AND period_end = ?
LIMIT 1;

-- name: InsertPeriodPlan :one
INSERT INTO period_plans (scope, period_start, period_end, month_key, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING id, scope, period_start, period_end, month_key, created_at, updated_at;

-- The weeks attributed to a month: Monday-start weeks whose start day falls in
-- the month range (blueprint / plans route's getMonthWeeks). Weeks starting in
-- an adjacent month are deliberately absent.
-- name: ListWeekPlansStartingInRange :many
SELECT id, scope, period_start, period_end, month_key, created_at, updated_at
FROM period_plans
WHERE scope = 'week' AND period_start >= ? AND period_start <= ?
ORDER BY period_start ASC;

-- name: ListPeriodPlansByIDs :many
SELECT id, scope, period_start, period_end, month_key, created_at, updated_at
FROM period_plans
WHERE id IN (sqlc.slice('ids'));

-- Plan items ordered by (priority high->normal->low, position). A CASE is
-- required: plain lexicographic ASC would order high, low, normal. This is the
-- same expression the TS route puts in drizzle's orderBy.
-- name: ListPlanItemsByPlanID :many
SELECT *
FROM period_plan_items
WHERE period_plan_id = ?
ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
         position ASC;

-- name: ListPlanItemsByPlanIDs :many
SELECT *
FROM period_plan_items
WHERE period_plan_id IN (sqlc.slice('plan_ids'));

-- name: ListPlanItemsByParentIDs :many
SELECT *
FROM period_plan_items
WHERE parent_item_id IN (sqlc.slice('parent_ids'));

-- Minimal projection used by the month review to resolve an ancestor item's
-- period plan (composeInheritedChildGroups).
-- name: ListPlanItemPlanIDs :many
SELECT id, period_plan_id
FROM period_plan_items
WHERE id IN (sqlc.slice('ids'));

-- name: GetPlanItem :one
SELECT *
FROM period_plan_items
WHERE id = ?
LIMIT 1;

-- One hop of the deferral chain walk (getFulfillmentChain).
-- name: GetPlanItemDeferralLink :one
SELECT id, deferred_from_item_id
FROM period_plan_items
WHERE id = ?
LIMIT 1;

-- name: MaxPlanItemPosition :one
SELECT CAST(COALESCE(MAX(position), 0) AS INTEGER) AS max_position
FROM period_plan_items
WHERE period_plan_id = ?;

-- name: InsertPlanItem :one
INSERT INTO period_plan_items (period_plan_id, text, status, priority, is_important,
                               is_urgent, project_scope, parent_item_id,
                               deferred_from_item_id, position, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- PUT /plan-items/{id} rewrites only the fields present in the body; updated_at
-- always is. COALESCE(narg) is the sqlc spelling of drizzle's "only set defined
-- keys". parent_item_id has its own statement below because null is a real
-- value (clearing the link), not "absent".
-- name: UpdatePlanItem :one
UPDATE period_plan_items
SET text = COALESCE(sqlc.narg('text'), text),
    status = COALESCE(sqlc.narg('status'), status),
    priority = COALESCE(sqlc.narg('priority'), priority),
    is_important = COALESCE(sqlc.narg('is_important'), is_important),
    is_urgent = COALESCE(sqlc.narg('is_urgent'), is_urgent),
    project_scope = COALESCE(sqlc.narg('project_scope'), project_scope),
    position = COALESCE(sqlc.narg('position'), position),
    updated_at = sqlc.arg('updated_at')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: UpdatePlanItemWithParent :one
UPDATE period_plan_items
SET text = COALESCE(sqlc.narg('text'), text),
    status = COALESCE(sqlc.narg('status'), status),
    priority = COALESCE(sqlc.narg('priority'), priority),
    is_important = COALESCE(sqlc.narg('is_important'), is_important),
    is_urgent = COALESCE(sqlc.narg('is_urgent'), is_urgent),
    project_scope = COALESCE(sqlc.narg('project_scope'), project_scope),
    position = COALESCE(sqlc.narg('position'), position),
    parent_item_id = sqlc.narg('parent_item_id'),
    updated_at = sqlc.arg('updated_at')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DeletePlanItem :exec
DELETE FROM period_plan_items WHERE id = ?;

-- name: ClearPlanItemChildParents :exec
UPDATE period_plan_items
SET parent_item_id = NULL, updated_at = ?
WHERE parent_item_id = ?;

-- name: DeleteEventPlanReferencesByPlanItemID :exec
DELETE FROM event_plan_references WHERE plan_item_id = ?;

-- name: ListPlanReferrerEvents :many
SELECT raw_events.id, raw_events.content, raw_events.event_time
FROM event_plan_references
INNER JOIN raw_events ON event_plan_references.event_id = raw_events.id
WHERE event_plan_references.plan_item_id = ?;

-- Distinct event ids referencing any of the given plan items. Callers that
-- combine several items' evidence pass the union of their chain ids here so
-- overlapping evidence is counted once (getFulfillmentEventIds).
-- name: ListFulfillmentEventIDs :many
SELECT DISTINCT event_id
FROM event_plan_references
WHERE plan_item_id IN (sqlc.slice('plan_item_ids'));

-- No ORDER BY on purpose: the TS getFulfillingEvents query has none, and the
-- returned row order is not part of the contract.
-- name: ListFulfillingEvents :many
SELECT raw_events.id, raw_events.content, raw_events.event_time, raw_events.source
FROM event_plan_references
INNER JOIN raw_events ON event_plan_references.event_id = raw_events.id
WHERE event_plan_references.plan_item_id IN (sqlc.slice('plan_item_ids'));

-- name: ListPlanItemCommentsByItemIDs :many
SELECT plan_item_comments.id, plan_item_comments.plan_item_id,
       plan_item_comments.content, plan_item_comments.author,
       plan_item_comments.created_at, period_plans.scope,
       period_plans.period_start, period_plans.period_end, period_plans.month_key
FROM plan_item_comments
INNER JOIN period_plan_items ON plan_item_comments.plan_item_id = period_plan_items.id
INNER JOIN period_plans ON period_plan_items.period_plan_id = period_plans.id
WHERE plan_item_comments.plan_item_id IN (sqlc.slice('plan_item_ids'))
ORDER BY plan_item_comments.created_at ASC, plan_item_comments.id ASC;

-- getChainCommentCount does not join: an orphan comment row would count here
-- but not in the list, exactly like the TS count.
-- name: CountPlanItemCommentsByItemIDs :one
SELECT COUNT(*)
FROM plan_item_comments
WHERE plan_item_id IN (sqlc.slice('plan_item_ids'));

-- name: InsertPlanItemComment :one
INSERT INTO plan_item_comments (plan_item_id, content, author, created_at)
VALUES (?, ?, ?, ?)
RETURNING id, plan_item_id, content, author, created_at;

-- name: GetPlanItemComment :one
SELECT id, plan_item_id, content, author, created_at
FROM plan_item_comments
WHERE id = ?
LIMIT 1;

-- name: InsertCommentReference :exec
INSERT INTO comment_references (comment_id, referenced_event_id, created_at)
VALUES (?, ?, ?);

-- name: DeleteCommentReferencesByCommentID :exec
DELETE FROM comment_references WHERE comment_id = ?;

-- name: DeletePlanItemComment :execrows
DELETE FROM plan_item_comments WHERE id = ?;

-- Cascade helper for plan item deletion: drop the citation rows of every
-- comment pinned to the item, then the comments themselves.
-- name: DeleteCommentReferencesByPlanItemID :exec
DELETE FROM comment_references
WHERE comment_id IN (SELECT id FROM plan_item_comments WHERE plan_item_id = ?);

-- name: DeletePlanItemCommentsByPlanItemID :exec
DELETE FROM plan_item_comments WHERE plan_item_id = ?;
