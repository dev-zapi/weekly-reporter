// Shared formatting for the plan-item comment scripts.
//
// Kept separate from client.mjs so the HTTP/auth plumbing stays generic and
// the output shape has one home: the list and add commands must render authors
// and source periods identically.

/** Browser comments carry no author; the UI (and the skill) renders them as the user. */
export function authorLabel(author) {
  return author ?? 'user'
}

/** ISO timestamp → `YYYY-MM-DD HH:mm UTC`; unparseable values pass through. */
export function formatCommentTime(createdAt) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return String(createdAt ?? '')
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * One chain comment: comment id, the item it is pinned to, time, author, source
 * period, then the text. The owning item id is printed because deleting an
 * ancestor's comment goes through that ancestor item's nested route.
 */
export function formatCommentLine(comment) {
  const period = comment.sourcePeriod?.label ?? 'unknown period'
  return `  #${comment.id} %${comment.planItemId} [${formatCommentTime(comment.createdAt)}] [${authorLabel(comment.author)}] [${period}] ${comment.content}`
}

/** Full list output: a count header plus one line per chain comment. */
export function formatCommentList(itemId, comments, commentCount) {
  if (comments.length === 0) {
    return `No comments on plan item %${itemId}.`
  }
  const count = commentCount ?? comments.length
  return [
    `Plan item %${itemId}: ${count} ${count === 1 ? 'comment' : 'comments'}`,
    ...comments.map(formatCommentLine),
  ].join('\n')
}
