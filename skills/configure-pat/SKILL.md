---
name: configure-pat
description: >-
  Configure machine-level Personal Access Token credentials for weekly-reporter API access.
  Use this skill when skill scripts return HTTP 401 Unauthorized errors, when provisioning
  a new machine or agent, or when rotating an expired or revoked PAT. Sets up the credentials
  in ~/.config/weekly-reporter/auth.json so all skill scripts can authenticate automatically.
---

Configure machine-level PAT (Personal Access Token) credentials so skill scripts can authenticate with the weekly-reporter API.

## When to use

- Skill scripts return `Error: Unauthorized (HTTP 401)` from the API
- Setting up a new machine, agent, or development environment
- Rotating an expired or revoked PAT
- First-time setup after installing weekly-reporter

## How it works

The script manages `~/.config/weekly-reporter/auth.json`, which stores both the startup password (for admin operations) and machine-level credentials (for API calls). It preserves the password field while updating only the machine credentials.

## Usage

### Option 1: Interactive (recommended)

Create a PAT via the API using the startup password:

```bash
node scripts/configure-pat.mjs --base-url http://localhost:6868
```

The script prompts for the startup password, calls `POST /api/auth/pats` to create a new PAT, and saves it to `auth.json`.

Optional: specify a custom name for the PAT (defaults to `<hostname>-cli`):

```bash
node scripts/configure-pat.mjs --base-url http://localhost:6868 --name my-laptop
```

### Option 2: Manual PAT

Create a PAT manually via the web UI (Security page), then configure it:

```bash
node scripts/configure-pat.mjs --pat wrp_xxxxxxxxxxxx --base-url http://localhost:6868
```

Both options produce equivalent credentials. The web UI path is useful when you don't have the startup password handy or prefer a GUI.

### View current configuration

```bash
node scripts/configure-pat.mjs --show
```

Displays the current machine credentials with the PAT masked (first 6 + last 4 characters).

### Clear credentials

```bash
node scripts/configure-pat.mjs --clear
```

Removes the machine credentials while preserving the startup password. Use this when decommissioning a machine or rotating credentials.

## File format

The script manages `~/.config/weekly-reporter/auth.json`:

```json
{
  "password": "<startup password>",
  "machine": {
    "baseUrl": "http://localhost:6868",
    "pat": "wrp_xxxxxxxxxxxx"
  }
}
```

The file is created with `chmod 600` permissions (owner read/write only). The script never overwrites the `password` field or any unknown fields.

## Credential resolution

Skill scripts resolve credentials in this order (highest to lowest priority):

1. Environment variables: `WEEKLY_REPORTER_PAT`, `WEEKLY_REPORTER_BASE_URL`, `WEEKLY_REPORTER_URL`
2. Machine credentials from `auth.json`
3. Defaults: `http://localhost:6868` for base URL, no PAT

Environment variables override file-based credentials, which is useful for CI/CD or temporary overrides.

## Troubleshooting

**Error: Unauthorized (HTTP 401)**
- PAT is missing, invalid, expired, or revoked
- Run this skill to set up a new PAT
- Check that the base URL is correct

**Error: Cannot reach weekly-reporter**
- Server is not running or base URL is wrong
- Start the server: `npm run dev`
- Verify the base URL with `--show`

**Warning: File permissions should be 600**
- The auth.json file has insecure permissions
- The script attempts to fix this automatically on write
- Manual fix: `chmod 600 ~/.config/weekly-reporter/auth.json`
