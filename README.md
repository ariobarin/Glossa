# Glossa

Glossa lets ChatGPT work with one project on your computer, using the files and development tools already there.

Use it when a task depends on local state such as an existing checkout, uncommitted changes, build tools, test databases, emulators, or generated files. Glossa is not another model or coding agent. ChatGPT handles the conversation and reasoning; Glossa provides controlled access to the local project.

## Quick start

Install the CLI with Node.js 22.9 or newer:

```shell
npm install --global @ariobarin/glossa
```

Add this MCP server to ChatGPT using OAuth:

```text
https://mcp.glossa.sh/mcp
```

Then open a terminal in the project and start Glossa:

```shell
glossa
```

The first time a computer runs Glossa, it shows a short pairing code. Enter it on the Glossa control panel from any browser to enroll the computer; a headless or SSH-only machine needs no local browser. The CLI stores only its revocable device credential, not a Google or Auth0 refresh token.

Follow the [quickstart](https://glossa.sh/docs/quickstart) for the complete connection flow. Self-contained installers are covered in the [operations guide](docs/operations.md).

## Choose access

| Profile | Read files | Edit files inside the project | Run local commands |
| --- | --- | --- | --- |
| `read-only` | Yes | No | No |
| `workspace` (default) | Yes | Yes | No |
| `system` | Yes | Yes | Yes |

The default is useful for most code changes because it permits guarded file edits without command execution.

> **`system` is not sandboxed.** Commands have the full environment, credentials, filesystem permissions, and network access of the operating-system account that started Glossa. They are not confined to the selected project.

Expose only a narrow project you trust. Keep credentials and regulated or otherwise sensitive data out of the workspace. See [Security and permissions](https://glossa.sh/security) before enabling `system`.

## How it works

```text
ChatGPT
  -> OAuth-protected Glossa relay
  -> outbound worker running on your computer
  -> one folder you selected
```

The worker initiates the connection, so Glossa does not require an inbound port. The relay routes authenticated requests to the active worker and does not store a repository copy.

## Common controls

Press `d` in the worker terminal to list and revoke the account's devices, and `q` or Ctrl+C to disconnect the workspace immediately.

```shell
glossa unpair
glossa update --check
```

## Security boundary

Structured file tools stay inside the selected root and reject absolute paths, parent traversal, and linked-path escapes. The relay and local worker both enforce the selected access profile. The `system` warning above describes the separate command boundary.

Read the [public security overview](https://glossa.sh/security), [technical threat model](docs/security.md), and [private reporting policy](SECURITY.md) for details.

## Local development

Node.js 22.9 or newer and Docker are required:

```powershell
npm run dev:setup
npm run dev
```

Stop local Postgres with `npm run dev:down`.

### Local integration

The full flow — pairing, device management, MCP, and a live worker — runs locally without touching the production tenant or relay:

```powershell
npm run integration:smoke
```

The harness starts a local development issuer, boots the relay against local Postgres, pairs a throwaway device, and round-trips an MCP `read_file` through a live worker before revoking the device.

For manual end-to-end work, run the development issuer and the relay in separate terminals:

```powershell
npm run dev:auth   # prints the relay .env and CLI environment values
npm run dev
```

Point the CLI at the local stack with the printed environment values. The development issuer signs any requested identity and auto-approves pairing; never deploy it.

## User documentation

- [Quickstart](https://glossa.sh/docs/quickstart)
- [Why Glossa](https://glossa.sh/docs/why)
- [Security and permissions](https://glossa.sh/security)
- [Support](https://glossa.sh/support)
- [Privacy](https://glossa.sh/privacy)
- [Terms](https://glossa.sh/terms)

## Technical documentation

- [Operations guide](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security and threat model](docs/security.md)
- [Self-hosting](docs/self-hosting.md)

## Maintainer and review documentation



- [Managed identity and reviewer access](docs/managed-identity.md)
- [MCP metadata operations](docs/metadata-operations.md)
- [Restricted Data review](docs/restricted-data.md)
- [Submission readiness](docs/submission-readiness.md)
- [Plugin submission demo recording](docs/demo-recording.md)
- [App submission packet](docs/app-submission-packet.md)
