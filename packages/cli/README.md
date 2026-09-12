# @ariobarin/glossa

The `glossa` CLI connects one project on your computer to the Glossa MCP relay through an authenticated outbound worker. The npm package supports Windows, macOS, and Linux and requires Node.js 22.9 or newer.

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

Pass a directory for another project and `--label <name>` to identify concurrent workers. Interactive mode shows the root, access, connection, and recent activity. Press `q` or Ctrl+C to disconnect.

Run `glossa --headless` under an operating-system supervisor for an unattended worker. It accepts the same options but skips the HUD and local activity history. Send SIGINT or SIGTERM to disconnect it.

On first run, redeem the printed pairing code in the Glossa control panel from any browser. The CLI stores only its revocable device credential. Later sessions reuse that pairing without user sign-in.

Press `d` to list and revoke devices. Run `glossa unpair` to revoke this computer and remove its pairing.

Useful controls:

```shell
glossa unpair
glossa update --check
```

See the [quickstart](https://glossa.sh/docs/quickstart), [operations guide](https://github.com/ariobarin/glossa/blob/main/docs/operations.md), and [security overview](https://glossa.sh/security).
