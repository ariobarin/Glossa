# Glossa

Glossa lets ChatGPT work inside one local coding workspace that the user explicitly exposes.

```text
ChatGPT
  -> OAuth protected MCP relay
  -> authenticated outbound worker connection
  -> one explicitly exposed local directory
```

Glossa is an execution bridge, not an agent. ChatGPT owns the model, conversation, planning, and approvals. The local worker owns file containment and command execution.

## Why Glossa

Codex and ChatGPT Work share usage. Glossa connects the regular Chat surface to one local workspace without putting another model, planner, or agent in the middle.

## Status

Glossa is an open beta for Windows, macOS, and Linux. The managed relay is live at `https://mcp.glossa.sh/mcp`. A valid Glossa login activates access automatically.

The recommended open-beta install on Windows, macOS, and Linux uses npm:

```shell
npm install --global @ariobarin/glossa@beta
```

For a self-contained install without Node.js or npm, use the direct installer.

Windows:

```powershell
irm https://glossa.sh/install | iex
```

macOS or Linux:

```shell
curl -fsSL https://glossa.sh/install.sh | sh
```

Both direct installers are tracked in [`site`](site). They select the native
release for the computer and verify its SHA-256 checksum before installing it.

Open a terminal in the directory you want to expose, then run:

```shell
glossa
```

Glossa signs in automatically and exposes the current directory. Pass a directory to expose a different workspace. When several workspaces are online, add an explicit ephemeral label such as `glossa --label frontend` or `glossa --label frontend <directory>` so clients can distinguish them; Glossa never derives this label from the local path. Run `glossa doctor` for non-destructive local readiness checks before starting, or `glossa doctor --json` for scriptable output. JSON `ready` is false when warnings or failures remain, while the process exits nonzero only when a check fails.

On the first successful managed-relay connection on a computer, Glossa prints the ChatGPT quickstart link once. It records a `connect-hint-shown` marker in the local Glossa config directory so later starts stay quiet.

Starting `glossa` opens the live session display and authorizes connected clients to modify files inside that root and run commands with the full environment and permissions of the operating-system account that launched it. Press `q` or Ctrl+C to disconnect.

## ChatGPT

Glossa is not listed in the public plugin directory yet, so add it as a custom app in Developer Mode during the open beta. Follow the [quickstart](https://glossa.sh/docs/quickstart) to connect the managed Glossa endpoint.

See the [open beta guide](docs/open-beta.md) for safe setup, verification, and troubleshooting.

## Local development

Node 24 and Docker are required. Start local Postgres, create `.env` when missing, build, and migrate with:

```powershell
npm run dev:setup
npm run dev
```

Stop local Postgres with `npm run dev:down`.

Glossa uses the managed relay by default. See [self-hosting](docs/self-hosting.md) if you prefer to operate your own relay, database, identity configuration, and CLI build.

## Documentation

- [Open beta guide](docs/open-beta.md)
- [Self-hosting](docs/self-hosting.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [API and protocol](docs/protocol.md)
- [Managed identity operations](docs/managed-identity.md)
