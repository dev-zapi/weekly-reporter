# init — machine credentials (机器级凭据)

`wrp init` provisions **this machine's** credential: the PAT and API base URL that
every other `wrp` command reads. It is the only command that writes
`~/.config/weekly-reporter/auth.json`; everything else only reads it.

```
wrp init --pat <token> [--base-url <url>]     store a PAT made in the web UI
wrp init --base-url <url> [--name <name>]     prompt for the 启动密码 and create a PAT
wrp init --show                               verify the setup, token masked
wrp init --clear                              decommission this machine
wrp init                                      interactive, against the resolved base URL
```

The flags are **mode switches, not modifiers**: exactly one mode per invocation.
`--pat` with `--base-url` is one mode (store both); any other combination is a
`✗ conflicting init modes` error, so a half-typed command can never silently pick
a mode. `--base-url` alone is the interactive mode, and a bare `wrp init` is the
same mode against the base URL that is already configured.

## Mode 1 — `--pat` (token from the web UI)

Use when the user already created a PAT on the app's security page.

```
wrp init --pat wrp_abc123…  --base-url http://127.0.0.1:6868
```

Writes `machine.pat` (and `machine.baseUrl` when given), then prints a masked
confirmation plus the effective base URL. The token itself is never echoed —
when the user pastes one into the session, do not repeat it back either.

## Mode 2 — `--base-url` (interactive, startup password)

Use on a fresh machine, when there is no PAT yet. Requires the 启动密码 (startup
password) of the deployment — ask the user for it, it is not stored anywhere the
client can read.

The prompt is written to **stderr** and reads one line from stdin, so it must be
run in a session where the user can type. The token is created via
`POST /api/auth/pats` with the password as a `Bearer` token, and the returned
plaintext token is only ever returned by that one response (ADR-0020) — it is
stored immediately.

- `--name <name>` sets the PAT name shown in the web UI; default is
  `<hostname>-cli`, which is what tells the user later which machine to revoke.
- A wrong password answers `401` and the command exits non-zero **without writing
  anything** — false credentials are never persisted. Ask for the password again
  and re-run.
- The created PAT is stored together with the base URL, so no separate
  `--base-url` is needed afterwards.

## Mode 3 — `--show`

Prints the configured base URL and the PAT masked as `first6...last4` (shorter
tokens print as `****`), plus the config file's permissions. If the file is not
`600` it appends a `⚠` line with the `chmod 600` fix, because the file can hold
the startup password as well as the PAT. Use this to verify a provisioning step
without exposing the credential.

When nothing is configured it prints `No machine credentials configured.` and
exits `0` — that is an answer, not a failure.

## Mode 4 — `--clear`

Removes `machine.pat` and `machine.baseUrl` and nothing else: a `password` field
in the same file and any fields a future version may add survive. Once `machine`
is empty it is dropped entirely. Use it when decommissioning a machine; the PAT
should also be revoked on the security page, since clearing the local file does
not revoke the token server-side.

## What gets written

`~/.config/weekly-reporter/auth.json`, directory `0700`, file `0600`, JSON with a
trailing newline. Every write is a read-modify-write of the `machine` member, so
concurrent-ish edits and unknown fields are preserved. If the file was left with
looser permissions it is corrected to `600` on the next write.

## Credential resolution order (read side)

Every other command resolves credentials in this order, first hit wins:

1. `WEEKLY_REPORTER_PAT` (token) and `WEEKLY_REPORTER_BASE_URL` (alias
   `WEEKLY_REPORTER_URL`) — environment wins over the file.
2. `machine.pat` / `machine.baseUrl` written by `wrp init`.
3. Base URL falls back to `http://localhost:6868`.

A missing credential never crashes a command; the API simply answers `401`. So
"it works in one shell but not another" is almost always an env var winning over
the file — check `env | grep WEEKLY_REPORTER` before re-provisioning.

## Agent handoff on 401

Any command that gets a `401` prints a single `✗` line whose fix hint is:

```
! node {baseDir}/scripts/wrp.mjs init
```

Give the user that line **verbatim**: the `!` prefix makes the agent host run it
in the current session, where the interactive prompt can reach the user's
terminal. Do not ask them to run `wrp init` themselves in another shell, and do
not hand-edit `auth.json` on their behalf — the password prompt is the whole
point of the handoff.

Recovery flow:

1. The command fails with `✗ unauthorized (HTTP 401) …`.
2. Hand the user the `!` line above (add `--base-url <url>` if the deployment is
   not on the default port).
3. After they run it, re-run the original command — the new credential is picked
   up with no restart.

If the user says their PAT expired instead, they can create a new one in the web
UI and store it with `wrp init --pat <token>`; both paths produce an equivalent
machine credential.
