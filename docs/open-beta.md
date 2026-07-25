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

After Glossa starts, press `u` to update using the original installation method. You can also run `glossa update` directly.

## Start a worker

Open a terminal in a disposable repository and run:

```shell
glossa
```

Glossa opens Google sign-in automatically when needed. Choose the Google account you want to use for Glossa. After sign-in, the session display shows the workspace, connection, activity, and security warning. Press `s` for account and device status, `d` for recent activity, or `q` or Ctrl+C to disconnect. Press `?` to see every key.

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

- Run `glossa doctor` for non-destructive local checks of the runtime, Git worktree, endpoints, and stored credentials. Use `glossa doctor --json` in scripts. A stored credential is not a live sign-in check, so start Glossa to validate it when needed.
- Press `s` in Glossa or run `glossa status` to check the account, relay, enrolled devices, and active workers.
- No Create option: confirm Developer Mode is enabled and your workspace role has access.
- No online devices: confirm the `glossa` terminal is still running.
- App setup cannot discover tools: confirm `https://mcp.glossa.sh/healthz` returns `{"ok":true,"service":"glossa-relay"}`.
- OAuth loops or expires: reopen the custom Glossa app and authorize it again.
- Wrong Google account: press `l` in Glossa and confirm, or run `glossa logout`. Open Glossa under **Settings > Plugins** in ChatGPT and disconnect it, then reconnect and sign in on both sides with the same Google account. Use **Settings > Apps** if that is the label your workspace shows.
- Account access fails: open a GitHub issue without including tokens, credentials, or local paths.

## Disconnect

Press `q` or Ctrl+C in the worker terminal. The device remains enrolled for later sessions, but it is offline and cannot access the local workspace while the worker is stopped.

Press `l` and confirm, or run `glossa logout`, to sign out locally and in the browser.

Press `s` to list enrolled computers, then `r` to revoke one. The direct forms are `glossa devices` and `glossa devices revoke <id>`.
