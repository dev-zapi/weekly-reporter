# All-Branches Collection for Empty Git-Local Branch Config

An empty branch configuration on a `git-local` collection source now means "collect all local branches" (`refs/heads`), not "the currently checked-out branch". Remote sources are unchanged: empty still means the repository default branch. Each local branch keeps its own committer-date cursor so a branch that appears later with older commits is not silently missed.

**Status**: accepted

**Considered Options**:
- Empty-config semantics (git-local): all local branches (chosen) vs the currently checked-out branch (previous behavior) vs the repository default branch.
- Scope: git-local only (chosen) vs also changing remote sources. Remote keeps "empty = default branch", so empty now means different things per source type.
- What "all branches" includes: local heads only, `refs/heads` (chosen) vs also remote-tracking refs (`--all`) vs also tags. The author-email filter still applies either way.
- Collection + cursor strategy: enumerate local heads at sync time with a per-branch cursor (chosen) vs a single `git log --branches` with one shared cursor (loses attribution; a late-appearing branch with older commits is missed, and sha dedup only prevents duplicates, it cannot recover misses) vs a full re-scan every sync relying on sha dedup (never misses but no attribution and re-reads full history).
- Cursor storage: a new `config.branchCursors[]` while `config.branches` stays empty as the "all" sentinel (chosen) vs materializing discovered branches into `config.branches` plus a mode flag (rejected: the edit form reads `config.branches` into its branch chips, so discovered branches would appear as explicit configuration and the "leave blank = all" sentinel would be lost).
- Multi-branch commit attribution: `metadata.branch` is the first containing branch in "current branch first, then alphabetical" order (chosen). Attribution is display-only and does not affect collection or cursors.
- Deleted local branches: prune their cursors each sync (chosen) vs keep orphans. A pruned branch that later reappears re-scans full history, deduped by sha.
- Existing empty-config git-local sources: apply the new semantics uniformly on the next sync, with a one-time deduped backfill (chosen) vs grandfathering the old checked-out-branch behavior.
- Pull before log: keep `git pull origin <current branch>` only (chosen); other local heads are user-managed, and a full refresh stays in the separate manual Fetch action (ADR 0009).

**Consequences**:
- `CollectSourceConfig` gains `branchCursors?: Array<{ name: string; lastCommitTime: string | null }>`, used only in git-local all-branches mode; explicit-branch sources (ADR 0010) and remote sources are untouched.
- The first sync after upgrade for an empty-config git-local source backfills history from all local branches; `sourceId + sha` dedup prevents duplicate events.
- Event cards may show branch labels where they previously showed none, and a commit shared across branches is labeled with exactly one branch.
- The git-local form's "leave blank" helper text changes from "follow the repository default branch" to "collect all local branches".
