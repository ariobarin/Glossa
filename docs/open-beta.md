# Open beta guide

Glossa is currently an open beta for Windows, macOS, and Linux. Start with a folder that does not contain credentials or important work.

## Requirements

- Node.js 22.9 or newer if you install with npm
- Developer Mode enabled in ChatGPT

Glossa is not listed in the public plugin directory yet, so add it as a custom app through Developer Mode during the open beta.

## Install and connect

The recommended install on Windows, macOS, and Linux uses npm:

```shell
npm install --global @ariobarin/glossa@beta
```

If you do not want Node.js or npm, install the self-contained executable.

Windows:

```powershell
irm https://glossa.sh/install | iex
```

macOS or Linux:

```shell
curl -fsSL https://glossa.sh/install.sh | sh
```

The direct installer detects the operating system and architecture, verifies the
downloaded executable with SHA-256, and installs it for the current user. To
inspect the Windows script first:

```powershell
irm https://glossa.sh/install -OutFile install.ps1
Get-Content .\install.ps1
.\install.ps1
```

To update Glossa, run the same npm or direct installer command again.

## Start a worker

Open a terminal in a disposable directory and run:

```shell
glossa
```

Glossa opens Google sign-in automatically when needed. Choose the Google account
you want to use for Glossa. When you plan to expose several workspaces at once,
start each with an explicit label such as `glossa --label frontend`; the label
is sent only as ephemeral routing metadata and is never inferred from the local
path. After sign-in, the terminal shows the workspace, device, and current
connection or tool status. Press `d` for compact tool history, `s` for account
and device status, or `?` for help. Press `q` or Ctrl+C to disconnect.

Starting Glossa authorizes connected clients to modify files inside the exposed root and run commands with the full environment and permissions of your operating-system account. Do not expose your home directory, a filesystem root, or a folder containing credentials.

## Enable Developer Mode and add Glossa

1. Follow OpenAI's [Developer Mode guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta).
2. Open **Settings > Plugins/Apps** and enable **Developer Mode**.
3. Choose **Create**.
4. Name the custom app **Glossa**, enter `https://mcp.glossa.sh/mcp` as the MCP server endpoint, and choose OAuth authentication.
5. Sign in with the same Google account as the worker, then choose **Create**.

You do not need to create OAuth credentials, configure networking, or operate hosted infrastructure.

## Verify the connection

Start a ChatGPT conversation with the Dev-labeled Glossa app selected and ask:

```text
List my connected devices.
```

The result should include one online device with root path `.`. Then try a harmless read:

```text
Use Glossa to read a file that exists in my active workspace.
```

Only test writes and commands inside a folder you are comfortable modifying.

## Troubleshooting

- Run `glossa status` in another terminal to check the account, relay, enrolled devices, and active workspaces.
- No Create option: confirm Developer Mode is enabled and your workspace role has access.
- No online devices: confirm the `glossa` terminal is still running.
- App setup cannot discover tools: confirm `https://mcp.glossa.sh/healthz` returns `{"ok":true,"service":"glossa-relay"}`.
- OAuth loops or expires: reopen the custom Glossa app and authorize it again.
- Wrong Google account: stop every Glossa worker, run `glossa logout`, then disconnect and reconnect Glossa under **Settings > Plugins** in ChatGPT. Sign in on both sides with the same Google account. Use **Settings > Apps** if that is the label your workspace shows.
- Account access fails: open a GitHub issue without including tokens, credentials, or local paths.

## Disconnect

Press Ctrl+C in the worker terminal. The device remains enrolled for later sessions, but it is offline and cannot access the local workspace while the worker is stopped.

Run `glossa logout` to sign out locally and in the browser.

Run `glossa status` to list enrolled computers, then use `glossa devices revoke <id>` to remove one you no longer trust.
