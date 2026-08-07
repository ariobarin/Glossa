# Connect ChatGPT to a local workspace

Install Glossa, expose one folder with an explicit permission boundary, and confirm the connection.

> The default profile can edit files inside the selected root but cannot run commands. `system` access is a separate elevation that inherits the worker account's environment, credentials, filesystem permissions, and network access. Review the [security model](/docs/security) before enabling it.

## 1. Install Glossa

The npm installation requires Node.js 22.9 or newer.

```shell
npm install --global @ariobarin/glossa
```

## 2. Start a workspace

Open a terminal in the folder ChatGPT should use, then choose the least authority the task needs.

Guarded file reads and writes, with commands disabled:

```shell
glossa
```

Inspection only:

```shell
glossa --access read-only
```

Local builds, tests, Git, or other project commands:

```shell
glossa --access system
```

Sign in if prompted and keep the terminal open. The Glossa screen shows the selected profile and workspace. Press Ctrl+C or `q` to disconnect.

## 3. Add Glossa to ChatGPT

1. In ChatGPT web, follow [OpenAI's Developer Mode guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) to create a custom MCP app.
2. Name it **Glossa** and enter this MCP server URL:

```text
https://mcp.glossa.sh/mcp
```

3. Choose **OAuth**, then **Scan Tools**.
4. Complete authorization, wait for the tool scan, and choose **Create**. Use the same Glossa account in ChatGPT and the CLI.

Your ChatGPT workspace controls whether custom apps and write actions are available and which actions are enabled.

## 4. Test the connection

Select Glossa in a new chat and send:

```text
Use Glossa to list my connected workspaces and report each access profile.
```

Confirm the returned workspace reports the profile shown in the local terminal. For a default session, `writeFiles` is `true` and `runCommands` is `false`.

A request that only inspects the project should work with `read-only`. A request that edits files needs `workspace` or `system`. A request that runs a local command needs `system`; restart the worker with broader access only when the task genuinely requires it.

Having trouble? Visit [support](/support).
