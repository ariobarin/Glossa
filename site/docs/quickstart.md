# Connect ChatGPT to a local workspace

Install Glossa, start it in a project, and connect ChatGPT.

## 1. Install

Requires Node.js 22.9 or newer.

```shell
npm install --global @ariobarin/glossa
```

## 2. Start a workspace

Open a terminal in your project folder and run:

```shell
glossa
```

Sign in if prompted and keep the terminal open.

> Glossa starts with `workspace` access: ChatGPT can read and edit the selected project, but cannot run commands. `system` access is optional and unsandboxed; commands inherit the account's environment, credentials, filesystem permissions, and network access. [Review security](/security) before enabling it.

## 3. Add Glossa to ChatGPT

1. In ChatGPT web, use [Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) to create a custom MCP app.
2. Name it **Glossa** and use this MCP server URL:

```text
https://mcp.glossa.sh/mcp
```

3. Choose **OAuth**, authorize with the same Glossa account as the CLI, then **Scan Tools** and **Create**.

## 4. Test it

Select Glossa in a new chat and send:

```text
Use Glossa to list my connected workspaces and report each access profile.
```

If your workspace appears, you're connected.

Having trouble? Visit [support](/support).
