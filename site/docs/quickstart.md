# Connect ChatGPT to a local workspace

Install Glossa, connect one folder, and confirm it works.

> Glossa can edit files and run commands with the permissions of the account that starts it. Expose only a folder you trust. Review the [security model](/docs/security).

## 1. Install Glossa

Requires Node.js 22.9 or newer.

```shell
npm install --global @ariobarin/glossa@beta
```

## 2. Start Glossa

Open a terminal in the folder you want ChatGPT to use, then run:

```shell
glossa
```

Sign in if prompted, and keep this terminal open.

## 3. Add Glossa to ChatGPT

ChatGPT Pro supports Glossa's read and fetch tools. Full file and command access
requires ChatGPT Business, Enterprise, or Edu.

1. In ChatGPT web, follow [OpenAI's Developer Mode guide](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta) to enable Developer Mode and create a custom app.
2. Name it **Glossa** and enter this MCP server URL:

```text
https://mcp.glossa.sh/mcp
```

3. Choose **OAuth**, then **Scan Tools**.
4. Sign in with the same Google account used by Glossa, wait for the scan to finish, then choose **Create**.

## 4. Test the connection

In ChatGPT, select Glossa and send:

```text
Use Glossa to list my connected workspaces.
```

If your workspace appears, Glossa is ready. Having trouble? Visit [support](/support).
