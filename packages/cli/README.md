# @ariobarin/glossa

The `glossa` CLI connects one explicitly exposed local development workspace to the Glossa MCP relay through an outbound authenticated worker. Node.js 22.9 or newer is required for the npm installation.

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

The direct installers verify the native release checksum before installing it.

## Start a worker

The default `workspace` profile permits guarded reads and writes inside the selected root and disables commands:

```shell
glossa
```

Use the least authority required by the task:

```shell
glossa --access read-only
glossa --access workspace
glossa --access system
```

- `read-only` permits structured file inspection only.
- `workspace` permits structured file inspection and guarded edits inside the root.
- `system` additionally permits commands with the complete environment, credentials, filesystem permissions, and network access of the operating-system account that launched Glossa. Commands are not confined to the root.

Pass a directory to expose another project and use `--label <name>` when several online workspaces need a non-sensitive identifier. The terminal interface displays the selected access profile, workspace, device, connection state, and compact tool activity. Press `q` or Ctrl+C to disconnect.

Glossa signs in automatically when needed using OAuth Device Authorization Flow. Public client and resource identifiers are built in. Use the same Glossa account when authorizing the app in ChatGPT. OAuth and device credentials use the operating-system credential store; Glossa warns before using a restricted credential file fallback.

Glossa checks the stable release channel at most once per day before connecting. After disconnecting running workspaces, use `glossa update --check`, `glossa update`, `glossa update --policy auto`, or `glossa update --policy off` as needed.

Use `glossa status` to show the account, relay, enrolled devices, and active workspaces. Use `glossa devices revoke <id>` to revoke a device and `glossa logout` to remove local OAuth credentials and open browser sign-out.

The managed endpoint defaults to `https://mcp.glossa.sh`. Development deployments may override `GLOSSA_RELAY_ORIGIN` and `GLOSSA_WORKER_ORIGIN`. Plain HTTP is accepted only for loopback relay origins and loopback or private IPv4 worker origins.

See the [quickstart](https://glossa.sh/docs/quickstart) and [security model](https://glossa.sh/docs/security).
