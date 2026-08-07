# Connect ChatGPT to a local workspace

Install Glossa, start it in a project folder, and add the MCP app to ChatGPT.

> **Glossa starts in `workspace` mode.** ChatGPT can read and edit files in the selected folder, but it cannot run commands. `system` mode is explicit, is not sandboxed, and gives commands the full authority of the account running Glossa. [Review the security boundary](/security) before enabling it.

## 1. Install Glossa

The npm installation requires Node.js 22.9 or newer.

```shell
npm install --global @ariobarin/glossa
```

## 2. Start a workspace

Open a terminal in the project folder and run:

```shell
glossa
```

Other access levels:

- Inspection only: `glossa --access read-only`
- Local tests, builds, Git, or other project commands: `glossa --access system`

Sign in if prompted and keep the terminal open. The Glossa screen shows the selected project and access profile. Press Ctrl+C or `q` to disconnect.

Expose only a project you trust. Keep credentials and regulated or sensitive data out of the selected folder.

## 3. Add Glossa to ChatGPT

1. In ChatGPT web, follow [OpenAI's Developer Mode guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) to create a custom MCP app.
2. Name it **Glossa** and enter this MCP server URL:

```text
https://mcp.glossa.sh/mcp
```

3. Choose **OAuth**, then **Scan Tools**.
4. Complete authorization, wait for the tool scan, and choose **Create**. Use the same Glossa account in ChatGPT and the CLI.

Your ChatGPT workspace controls which app actions are available. Review requested writes and commands carefully.

## 4. Test the connection

Select Glossa in a new chat and send:

```text
Use Glossa to list my connected workspaces and report each access profile.
```

A default session should report `workspace` access: file edits enabled and commands disabled, matching the local terminal.

Need a different access level? Stop the worker and restart it with `--access read-only` or `--access system` only when the task requires it.

Having trouble? Visit [support](/support).
