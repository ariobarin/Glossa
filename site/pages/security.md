# Security and permissions

Glossa connects one project folder to an authenticated client through a local worker. The worker performs file operations and, only in `system` mode, local commands. The relay routes requests while the worker is online; it does not store a repository copy.

## Access profiles

| Profile | Read files | Change files and paths inside the project | Run commands |
| --- | --- | --- | --- |
| `read-only` | Yes | No | No |
| `workspace` (default) | Yes | Yes | No |
| `system` | Yes | Yes | Yes, after local approval |

The selected profile appears in the local terminal and in `list_workspaces`. Both the relay and the local worker enforce it.

> **`system` is powerful and is not sandboxed.** Each command needs local approval. Approved commands inherit the worker account's environment, credentials, filesystem permissions, and network access and are not confined to the project.

## What Glossa enforces

- Structured file tools stay inside one selected root and reject absolute paths, parent traversal, and linked-path escapes. Workspace mode can create directories, move files or directories, and delete paths without enabling commands.
- File changes require `workspace` or `system`; commands require `system` plus local approval.
- OAuth, account scoping, device credentials, and HTTPS protect the connection. HTTPS encrypts transport; the managed relay still processes plaintext tool traffic.
- The hosted relay keeps account, device, routing, and metadata-only audit records. It does not durably store file contents, command arguments, command output, environment variables, tokens, or local absolute paths.
- The local worker keeps command state only transiently. Default command responses remain bounded; when output is truncated, up to 1 MiB of stdout and 1 MiB of stderr can be read back in bounded ranges without rerunning the command. Terminal command records last no more than five minutes, at most eight recent records are kept, and retained output is deleted with its record.
- Press Ctrl+C or `q` in the worker terminal to disconnect immediately.

## Sensitive data

The public Glossa app is not intended for payment-card data subject to PCI DSS, protected health information, government identifiers, access credentials, or authentication secrets. Keep these categories out of the exposed project.

Glossa blocks recognizable authentication-secret patterns in text inputs and results, including every retained command-output range. `view_image` is an explicit exception: it validates a bounded PNG, JPEG, or WebP file but does not OCR pixels or scrub embedded metadata, so visual or metadata-based secrets are not covered by the text detector. These controls can prevent common accidental disclosures, but they are not a complete data-loss-prevention system or sandbox. Unknown, encoded, encrypted, fragmented, transformed, or visual values may not be recognized, and a command can send data over the network without printing it.

When credentials must be unreachable, run `system` in a credential-free dedicated operating-system account, container, or virtual machine with only the project and tools it needs.

## Safer use

- Start with the default `workspace` mode for ordinary code changes, directory creation, moves, and scoped deletions.
- Use `read-only` for inspection when no edits are needed.
- Enable `system` only when needed and review every command prompt.
- Expose a narrow project, never a home directory, filesystem root, credential store, or secrets directory.
- Stop the worker if the activity shown in the terminal is unexpected.

For implementation details and residual risks, read the [technical threat model](/docs/security). Data handling is described in the [privacy policy](/privacy).

## Report a security issue

Do not publish credentials, private source code, exploit details, or personal data. Use the [private security reporting process](https://github.com/ariobarin/glossa/security/advisories/new). See [support](/support) if private reporting is unavailable.
