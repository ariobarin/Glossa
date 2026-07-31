# Quickstart

Connect ChatGPT to a local workspace.

## Before you begin

Make sure you have:

- Node.js 22.9 or newer if you use the recommended npm install
- [Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) enabled in ChatGPT

> Glossa can modify files and run commands on your computer. Review the [security model](/docs/security).

## Step 1: Install Glossa

:::docs-tabs {"id":"install","storage":"glossa-install-method-v2","param":"install","label":"Install with","ariaLabel":"Install method","wide":true}
:::docs-tab {"value":"npm","label":"npm (Recommended)","selected":true}
Install the beta on Windows, macOS, or Linux:

```shell
npm install --global @ariobarin/glossa@beta
```
:::docs-tab-end
:::docs-tab {"value":"direct","label":"Direct installer"}
Install a self-contained executable without Node.js or npm.

:::docs-tabs {"id":"direct","storage":"glossa-direct-platform-v2","param":"platform","label":"Platform","ariaLabel":"Direct installer platform","nested":true}
:::docs-tab {"value":"windows","label":"Windows","selected":true}
```powershell
irm https://glossa.sh/install | iex
```
:::docs-tab-end
:::docs-tab {"value":"macos","label":"macOS"}
```shell
curl -fsSL https://glossa.sh/install.sh | sh
```
:::docs-tab-end
:::docs-tab {"value":"linux","label":"Linux"}
```shell
curl -fsSL https://glossa.sh/install.sh | sh
```
:::docs-tab-end
:::docs-tabs-end
:::docs-tab-end
:::docs-tabs-end

Confirm Glossa is available:

```shell
glossa --version
```

Glossa checks for updates at most once per day before connecting a workspace and
prints a notice by default. After disconnecting every running Glossa workspace,
check or install an update:

```shell
glossa update --check
glossa update
```

Use `glossa update --policy auto` to install an available update before the next
workspace connects, or `glossa update --policy off` to disable automatic checks.
The open beta follows the `beta` channel. Run `glossa update --channel stable`
to switch to stable releases once one is published.

## Step 2: Start a workspace

Open a terminal in the directory you want ChatGPT to use:

```shell
glossa
```

With no directory argument, Glossa exposes the current directory and signs in
automatically. To expose a different directory, run `glossa <directory>`.

> Keep this terminal open. Closing it disconnects that local workspace from ChatGPT.

## Step 3: Connect ChatGPT

1. Open **Settings > Plugins/Apps** and enable **Developer Mode**.
2. Choose **Create**.
3. Name the app **Glossa** and enter this MCP server URL:

```text
https://mcp.glossa.sh/mcp
```

4. Choose **OAuth**.
5. Sign in with the same Google account used by the Glossa CLI, then choose **Create**.

## Step 4: Verify the connection

Run `glossa status` in another terminal to check the account, relay, enrolled device, and active worker.

### Try a read

In ChatGPT, select Glossa and send:

```text
Use Glossa to list my connected workspaces.
```

If Glossa lists the workspace, the connection is ready. Ask it to read a file
next.

## What next

- Read [why Glossa works this way](/docs/why).
- Review the complete [security model](/docs/security).
- Visit [support](/support) if the worker, OAuth flow, or app does not connect.
