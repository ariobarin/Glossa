# Connect ChatGPT to a local workspace

Install Glossa, add it to ChatGPT, then pair the computer that will expose your project.

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

Review permissions and requested actions.

## 3. Start and pair a workspace

Open a terminal in your project folder and run:

```shell
glossa
```

On a computer that has not been paired before, Glossa prints a short one-time code and waits. In an authenticated ChatGPT conversation with Glossa enabled, approve the code shown by that terminal. The computer receives its own revocable device credential; it does not need your Google/Auth0 refresh token or a browser session. This works the same way on a headless machine reached over SSH.

Keep the terminal open after pairing. Later `glossa` runs on that computer reuse the device pairing without user sign-in. Run `glossa unpair` to revoke the computer before pairing it with another Glossa account.

> Glossa starts with `workspace` access: ChatGPT can read and edit the selected project, but cannot run commands. `system` access is optional and unsandboxed; commands inherit the account's environment, credentials, filesystem permissions, and network access. [Review security](/security) before enabling it.

## 4. Test it

Select Glossa in a new chat and send:

```text
Use Glossa to list my connected workspaces and report each access profile.
```

If your workspace appears, you're connected.

Having trouble? Visit [support](/support).
