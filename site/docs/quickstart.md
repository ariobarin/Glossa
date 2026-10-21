# Connect ChatGPT to your project

Add Glossa to ChatGPT, install the CLI, then start it in your project folder.

## 1. Add Glossa to ChatGPT

<p class="docs-action-row"><a class="primary-action" href="https://chatgpt.com/plugins/plugin_asdk_app_6ad2768d567c8191a369d9f6e6c79d11">Open Glossa in ChatGPT</a></p>

Select **Install plugin** and sign in. Review permissions and requested actions.

Can't install it from the plugin directory? [Add Glossa in developer mode](/docs/developer-mode) instead.

## 2. Install the CLI

Requires Node.js 22.9 or newer.

```shell
npm install --global @ariobarin/glossa
```

## 3. Start Glossa in your project

Open a terminal in your project folder and run:

```shell
glossa
```

The first time, enter the pairing code it shows on the [Glossa control panel](https://mcp.glossa.sh/panel). Keep the terminal open while you work.

> Glossa starts with `workspace` access: ChatGPT can read and edit this folder but cannot run commands. `system` access runs commands as your account and is unsandboxed. [Review security](/security) before turning it on.

## 4. Try it

<p class="docs-action-row"><a class="primary-action" href="https://chatgpt.com/?prompt=%40Glossa%20List%20my%20connected%20workspaces%20and%20their%20access.">Try it in ChatGPT</a></p>

This opens a new chat with the prompt filled in. If your workspace appears in the answer, you're connected.

Having trouble? Visit [support](/support).
