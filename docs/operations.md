# Operations guide

This guide covers installation, workspace selection, access profiles, account controls, updates, and troubleshooting for the managed Glossa service.

## Install

The npm package supports Windows, macOS, and Linux and requires Node.js 22.9 or newer:

```shell
npm install --global @ariobarin/glossa
```

Self-contained installers verify the selected native release checksum.

Windows:

```powershell
irm https://glossa.sh/install | iex
```

macOS or Linux:

```shell
curl -fsSL https://glossa.sh/install.sh | sh
```

## Select a project and access profile

Run Glossa from a narrow project directory, not a home directory or filesystem root:

```shell
cd C:\path\to\project
glossa
```

The default `workspace` profile permits structured reads and guarded writes inside the selected root, with commands disabled. Use `glossa --access read-only` for inspection. Use `glossa --access system` only when the task requires local commands.

A `system` command has the full operating-system authority of the account that started Glossa and is not confined to the selected root. See [Security and permissions](https://glossa.sh/security) for the complete boundary.

The terminal displays the selected root and access profile. Keep it open while using Glossa. Press `q` or Ctrl+C to disconnect.

## Connect ChatGPT

Create a custom MCP app in ChatGPT Developer Mode using OAuth and:

```text
https://mcp.glossa.sh/mcp
```

Authorize Glossa in ChatGPT and run **Scan Tools**. On first `glossa`, follow the browser authorization link. A headless worker prints the link to open elsewhere and retains no login credentials.

Verify discovery with:

```text
Use Glossa to list my connected workspaces and report each access profile and permission.
```

The returned profile and permissions should match the local terminal.

## Multiple workspaces

Start one process per project and add non-sensitive labels when clients need to distinguish them:

```shell
glossa --label frontend C:\work\frontend
glossa --label api C:\work\api
```

Glossa does not derive labels from local paths. A duplicate process for the same canonical root exits before login or relay connection.

## Interactive HUD

The HUD opens on **Workspace**, showing the exposed directory, paired computer, current access boundary, and newest activity. `A` opens full **Activity** history; `W` or Escape returns to Workspace. Workspace arrows change access, with confirmation before increases. `D` opens **Devices** for account-level device administration; use up/down and Enter or `R` to revoke. `?` opens Help.

## Local usage history

The CLI keeps an append-only usage history in the local Glossa config directory so future versions can show lifetime usefulness and hourly/daily trends. Each record contains only a timestamp plus either a session start or a tool type and success/failure outcome. It does not store tool arguments, paths, command text, file contents, or credentials, and the usage history is not sent to the relay.

## Updates

Glossa checks the stable release channel at most once per day before connecting and prints a notice by default.

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
glossa unpair
```

`status` shows the account, devices, and active workspaces. Revocation invalidates a device. `logout` signs out CLI account administration but does not unpair the computer. `unpair` revokes this computer and removes its local pairing. Disconnect Glossa in ChatGPT separately to revoke the client authorization.

## Verify a setup

1. Confirm the terminal shows the intended root and profile.
2. Confirm `list_workspaces` reports the same profile and permissions.
3. Read a non-sensitive file from the selected project.
4. Under `read-only`, confirm a write is rejected.
5. Under the default `workspace` profile, confirm a guarded edit succeeds and a command is rejected.
6. Under `system`, run only a bounded, non-destructive project command.
7. Stop the worker and confirm the workspace becomes unavailable.

## Troubleshooting

- **No online workspace:** keep the terminal open, complete any pending browser authorization, or confirm the stored pairing is still valid.
- **Wrong workspace:** stop it and restart in the intended project with a unique `--label`.
- **Permission error:** restart with broader access only if the task genuinely requires it.
- **`restricted_data_blocked`:** remove the credential or use a non-sensitive placeholder. Do not retry with encoding, another tool, or a shell fallback.
- **Wrong paired account:** stop workers, run `glossa unpair`, restart, and select the intended account in the browser authorization flow. Use `glossa logout` separately for CLI administration.
- **Tool definitions changed:** run **Scan Tools** again.
- **Service health:** confirm `https://mcp.glossa.sh/healthz` returns an object with `ok` set to `true`.
- **Sensitive security issue:** use the private process in [`SECURITY.md`](../SECURITY.md), not a public issue.
