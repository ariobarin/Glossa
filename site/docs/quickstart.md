# Connect ChatGPT to a local workspace

Install Glossa, connect ChatGPT, then start it in a project.

## 1. Install

Requires Node.js 22.9 or newer.

```shell
npm install --global @ariobarin/glossa
```

## 2. Add Glossa to ChatGPT

1. In ChatGPT web, use [Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) to create a custom MCP app.
2. Name it **Glossa** and use this MCP server URL:

```text
https://mcp.glossa.sh/mcp
```

3. Choose **OAuth**, then **Scan Tools**. Complete authorization, wait for the scan, then **Create**.

Connecting ChatGPT first lets the CLI reuse the same Glossa browser session on first run instead of forcing another Google account choice. Browser privacy settings or a different browser profile can still require sign-in again.

Review permissions and requested actions.

## 3. Start a workspace

Open a terminal in your project folder and run:

```shell
glossa
```

If prompted, approve this computer in the browser and keep the terminal open. With the same browser session used above, you should not need to choose or enter your Google account again.

> Glossa starts with `workspace` access: ChatGPT can read and edit the selected project, but cannot run commands. `system` access is optional and unsandboxed; commands inherit the account's environment, credentials, filesystem permissions, and network access. [Review security](/security) before enabling it.

## 4. Test it

Select Glossa in a new chat and send:

```text
Use Glossa to list my connected workspaces and report each access profile.
```

If your workspace appears, you're connected.

Having trouble? Visit [support](/support).
