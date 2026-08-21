# @ariobarin/glossa

The `glossa` CLI connects one project on your computer to the Glossa MCP relay through an authenticated outbound worker. The npm package supports Windows, macOS, and Linux and requires Node.js 18 or newer.

```shell
npm install --global @ariobarin/glossa
```

Start it in the project you want ChatGPT to use:

```shell
glossa
```

## Access profiles

| Profile | Read files | Edit files inside the project | Run commands |
| --- | --- | --- | --- |
| `read-only` | Yes | No | No |
| `workspace` (default) | Yes | Yes | No |
| `system` | Yes | Yes | Yes |

Use `glossa --access read-only` for inspection. Use `glossa --access system` only when the task needs local tests, builds, Git, or another project command.

> **`system` is not sandboxed.** Commands inherit the full environment, credentials, filesystem permissions, and network access of the operating-system account that started Glossa. They are not confined to the selected root.

Expose only a narrow project you trust. Keep credentials and regulated or sensitive data out of the workspace. Review the [security overview](https://glossa.sh/security) before enabling commands.

Pass a directory to expose another project, and add `--label <name>` when several online workspaces need a non-sensitive identifier. The terminal shows the selected project, access profile, connection state, and recent activity. Press `q` or Ctrl+C to disconnect.

The first time a computer runs Glossa, it shows a short pairing code. Enter it on the Glossa control panel from any browser to enroll the computer; a headless or SSH-only machine needs no local browser. The CLI stores only its revocable device credential, not a Google or Auth0 refresh token. Later workspace sessions reuse that pairing without user sign-in.

Press `d` in the terminal to list and revoke the account's devices. Run `glossa unpair` to revoke this computer and remove its local pairing before moving it to another Glossa account.

Useful controls:

```shell
glossa unpair
glossa update --check
```

See the [quickstart](https://glossa.sh/docs/quickstart), [operations guide](https://github.com/ariobarin/glossa/blob/main/docs/operations.md), and [security overview](https://glossa.sh/security).
