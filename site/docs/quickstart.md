# Quickstart

Connect ChatGPT to a local workspace.

## Before you begin

Make sure you have:

- Node.js 22.9 or newer if you use the recommended npm install
- [Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) enabled in ChatGPT

> Glossa can modify files and run commands on your computer. Review the [security model](/docs/security).

## Step 1: Install Glossa

<div class="docs-switcher" data-docs-tabs data-tabs-storage="glossa-install-method-v2">
  <p class="docs-switcher-label">Install with</p>
  <div class="docs-tabs docs-tabs-wide" role="tablist" aria-label="Install method">
    <button id="install-npm-tab" type="button" role="tab" aria-selected="true" aria-controls="install-npm" data-docs-tab="npm">npm (Recommended)</button>
    <button id="install-direct-tab" type="button" role="tab" aria-selected="false" aria-controls="install-direct" data-docs-tab="direct" tabindex="-1">Direct installer</button>
  </div>
  <div id="install-npm" class="docs-tab-panel" role="tabpanel" aria-labelledby="install-npm-tab" data-docs-tab-panel="npm">
    <p>Install the beta on Windows, macOS, or Linux:</p>
    <pre><code class="language-shell">npm install --global @ariobarin/glossa@beta</code></pre>
  </div>
  <div id="install-direct" class="docs-tab-panel" role="tabpanel" aria-labelledby="install-direct-tab" data-docs-tab-panel="direct" hidden>
    <p>Install a self-contained executable without Node.js or npm.</p>
    <div class="docs-switcher docs-switcher-nested" data-docs-tabs data-tabs-storage="glossa-direct-platform-v2">
      <p class="docs-switcher-label">Platform</p>
      <div class="docs-tabs" role="tablist" aria-label="Direct installer platform">
        <button id="direct-windows-tab" type="button" role="tab" aria-selected="true" aria-controls="direct-windows" data-docs-tab="windows">Windows</button>
        <button id="direct-macos-tab" type="button" role="tab" aria-selected="false" aria-controls="direct-macos" data-docs-tab="macos" tabindex="-1">macOS</button>
        <button id="direct-linux-tab" type="button" role="tab" aria-selected="false" aria-controls="direct-linux" data-docs-tab="linux" tabindex="-1">Linux</button>
      </div>
      <div id="direct-windows" class="docs-tab-panel" role="tabpanel" aria-labelledby="direct-windows-tab" data-docs-tab-panel="windows">
        <pre><code class="language-powershell">irm https://glossa.sh/install | iex</code></pre>
      </div>
      <div id="direct-macos" class="docs-tab-panel" role="tabpanel" aria-labelledby="direct-macos-tab" data-docs-tab-panel="macos" hidden>
        <pre><code class="language-shell">curl -fsSL https://glossa.sh/install.sh | sh</code></pre>
      </div>
      <div id="direct-linux" class="docs-tab-panel" role="tabpanel" aria-labelledby="direct-linux-tab" data-docs-tab-panel="linux" hidden>
        <pre><code class="language-shell">curl -fsSL https://glossa.sh/install.sh | sh</code></pre>
      </div>
    </div>
  </div>
</div>

Confirm Glossa is available:

```shell
glossa --version
```

After Glossa starts, press `u` to install the newest beta. You can also run `glossa update` directly.

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

Press `s` in Glossa to check the account, relay, enrolled device, and active worker. Press Esc to return to the workspace view. You can also run `glossa status` in another terminal.

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
