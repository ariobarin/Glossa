# Operations guide

This guide covers production installation, workspace access profiles, ChatGPT setup, updates, verification, and troubleshooting for the managed Glossa service.

## Install

The npm package supports Windows, macOS, and Linux and requires Node.js 22.9 or newer:

```shell
npm install --global @ariobarin/glossa
```

The self-contained installers verify the selected native release checksum.

Windows:

```powershell
irm https://glossa.sh/install | iex
```

macOS or Linux:

```shell
curl -fsSL https://glossa.sh/install.sh | sh
```

## Select a workspace and profile

Run Glossa from a narrow project directory, not a home directory or filesystem root.

```shell
cd C:\path\to\project
glossa
```

The default `workspace` profile permits structured reads and guarded writes inside the selected root, with commands disabled. Use `glossa --access read-only` for inspection and `glossa --access system` only when the requested task requires local commands.

A system-profile command inherits the worker account's full environment, credentials, filesystem permissions, and network access and is not confined to the selected root. Prefer a dedicated operating-system account, container, or virtual machine for sensitive work.

The terminal displays the canonical root and access profile. Keep it open while using Glossa. Press `q` or Ctrl+C to disconnect.

## Connect ChatGPT

Create a custom MCP app in ChatGPT Developer Mode using OAuth and:

```text
https://mcp.glossa.sh/mcp
```

Use the same Glossa account in ChatGPT and the CLI. Scan the tools, review the write and command annotations, and enable only the actions appropriate for the workspace.

Verify discovery with:

```text
Use Glossa to list my connected workspaces and report each access profile and permission.
```

The returned profile and permissions must match the local terminal. An operation outside the selected profile should return a non-retry permission error without reaching the worker.

## Multiple workspaces

Start one process per distinct canonical root and add non-sensitive labels when clients need to distinguish them:

```shell
glossa --label frontend C:\work\frontend
glossa --label api C:\work\api
```

Glossa does not derive labels from local paths. A duplicate process for the same root exits before login or relay connection.

## Updates

Stable releases use the `stable` update channel. Glossa checks at most once per day before connection and prints a notice by default.

```shell
glossa update --check
glossa update
glossa update --policy auto
glossa update --policy off
```

Disconnect every running workspace before installing an update.

## Account and device controls

```shell
glossa status
glossa devices revoke <id>
glossa logout
```

`status` shows the account, relay, enrolled computers, and active workspaces. Revocation invalidates the selected device. Logout removes local OAuth credentials and opens browser sign-out; disconnect Glossa in ChatGPT separately to revoke client authorization.

## Verification checklist

1. Confirm the terminal shows the expected canonical root and profile.
2. Confirm `list_devices` returns the same profile and permissions.
3. Read a non-sensitive fixture file.
4. Under `read-only`, confirm a write is rejected.
5. Under the default `workspace` profile, confirm a guarded fixture edit succeeds and a command is rejected.
6. Under `system`, run only a bounded, non-destructive validation command.
7. Stop the worker and confirm the workspace becomes unavailable.
8. Review the local activity view and hosted metadata-only audit entry.

## Pre-submission production check

After publishing the stable CLI and deploying the relay and website, run:

```shell
npm run review:check:production
```

This unauthenticated check verifies the live product positioning, stable npm `latest` tag, public legal and support pages, relay health, OAuth resource metadata, and MCP authentication challenge. Credentialed tool scanning and reviewer-account tests remain separate because reviewer secrets must not enter source control or CI logs.

## Troubleshooting

- No online workspace: confirm the worker terminal is still open and that the selected account matches ChatGPT.
- Wrong workspace: stop it and restart in the intended directory with a unique `--label`.
- Permission error: do not retry. Restart with broader access only if the user's task genuinely requires it.
- OAuth account mismatch: stop workers, run `glossa logout`, disconnect Glossa in ChatGPT, and authorize both sides with the intended account.
- Tool definitions changed: rescan or refresh actions in ChatGPT before testing the new contract.
- Service health: confirm `https://mcp.glossa.sh/healthz` returns an object with `ok` set to `true`.
- Sensitive security issue: use the private process in [`SECURITY.md`](../SECURITY.md), not a public issue.
