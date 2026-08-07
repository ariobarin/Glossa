# Glossa

Glossa is a user-controlled bridge that lets ChatGPT work in a local development workspace with the tools already installed on that computer.

```text
ChatGPT
  -> OAuth-protected public MCP relay
  -> authenticated outbound worker connection
  -> one explicitly exposed local directory
```

Glossa is not another model, coding agent, planner, conversation store, or command sandbox. ChatGPT owns the conversation and reasoning. The local Glossa worker enforces the selected workspace root and access profile, performs file operations, and—only when explicitly enabled—runs commands with the worker account's operating-system authority.

## Why Glossa exists

A remote ChatGPT app cannot directly see a project on a user's computer or use that computer's existing checkout, uncommitted changes, build tools, test databases, emulators, and development environment. Glossa supplies that missing boundary through an outbound worker; it does not attempt to replace ChatGPT's built-in writing, research, browsing, or coding features.

Use Glossa when a task genuinely depends on the local workspace or local toolchain. Do not use it for general questions, web research, or work that does not require the exposed project.

## Access profiles

Every worker starts with one visible, locally enforced profile. The relay enforces the same permissions before it queues work.

| Profile | File reads | File writes inside the root | Local commands |
| --- | --- | --- | --- |
| `read-only` | Yes | No | No |
| `workspace` (default) | Yes | Yes | No |
| `system` | Yes | Yes | Yes |

`system` is an explicit elevation. Commands inherit the complete environment, credentials, filesystem permissions, and network access of the operating-system account that launched Glossa. Commands are not confined to the exposed file root. Use a dedicated account, container, or virtual machine when stronger isolation is required.

## Install

The stable npm package supports Windows, macOS, and Linux and requires Node.js 22.9 or newer:

```shell
npm install --global @ariobarin/glossa
```

A self-contained installer is also available.

Windows:

```powershell
irm https://glossa.sh/install | iex
```

macOS or Linux:

```shell
curl -fsSL https://glossa.sh/install.sh | sh
```

The direct installers select the native release for the computer and verify its SHA-256 checksum before installing it.

## Start a workspace

Open a terminal in the directory to expose. The default permits guarded file edits but no commands:

```shell
glossa
```

For inspection only:

```shell
glossa --access read-only
```

Enable commands only for a task that requires the local toolchain:

```shell
glossa --access system
```

Pass a directory to expose a different workspace. When several workspaces are online, add a non-sensitive label so clients can distinguish them:

```shell
glossa --label frontend C:\path\to\project
```

Glossa never derives that label from the local path. One process may expose a canonical directory at a time for the same local account. The terminal interface displays the selected profile, workspace, device, connection state, and compact activity history. Press `q` or Ctrl+C to disconnect.

## Connect ChatGPT

The managed MCP endpoint is:

```text
https://mcp.glossa.sh/mcp
```

Until directory publication is complete, an authorized ChatGPT workspace administrator or developer can connect it as a custom MCP app in Developer Mode. Follow the [quickstart](https://glossa.sh/docs/quickstart) for the current flow and use the same Glossa account in ChatGPT and the CLI.

## Updates and account controls

Glossa checks for stable updates at most once per day before connecting and prints a notice by default. After disconnecting running workspaces:

```shell
glossa update --check
glossa update
```

Use `glossa update --policy auto` to install an available update before the next connection, or `glossa update --policy off` to disable automatic checks.

Use `glossa status` to inspect the signed-in account, relay, enrolled computers, and active workspaces. Use `glossa devices revoke <id>` to revoke a computer and `glossa logout` to remove local OAuth credentials and open browser sign-out.

OAuth and device credentials use the operating-system credential store. If it is unavailable, Glossa warns before using a restricted local file fallback.

## Security boundary

Structured file tools reject absolute paths, parent traversal, symlinks, junctions, and other escapes from the selected root. File writes are atomic and can be guarded by SHA-256 revision checks. The hosted relay routes encrypted requests but does not durably store file contents, command arguments, command output, environment variables, tokens, or local absolute paths.

The file boundary is not a command sandbox. `system` access should be treated as remote command authority for the worker account. Review the [security model](docs/security.md) before enabling it and use the [private security reporting process](SECURITY.md) for vulnerabilities.

## Local development

Node.js 22.9 or newer and Docker are required. Start local Postgres, create `.env` when missing, build, and migrate with:

```powershell
npm run dev:setup
npm run dev
```

Stop local Postgres with `npm run dev:down`.

Glossa uses the managed relay by default. See [self-hosting](docs/self-hosting.md) to operate a separate relay, database, identity configuration, and CLI build.

## Documentation

- [Operations guide](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Security and threat model](docs/security.md)
- [Protocol](docs/protocol.md)
- [Managed identity and reviewer access](docs/managed-identity.md)
- [Self-hosting](docs/self-hosting.md)
- [App submission packet](docs/app-submission-packet.md)
- [Privacy](https://glossa.sh/privacy)
- [Terms](https://glossa.sh/terms)
- [Support](https://glossa.sh/support)
