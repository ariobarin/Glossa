# Security and permissions

Glossa connects one project folder to an authenticated client through a local worker. The worker performs file operations and, only in `system` mode, local commands. The relay routes requests while the worker is online; it does not store a repository copy.

## Access profiles

| Profile | Read files | Edit files inside the project | Run commands |
| --- | --- | --- | --- |
| `read-only` | Yes | No | No |
| `workspace` (default) | Yes | Yes | No |
| `system` | Yes | Yes | Yes |

The selected profile appears in the local terminal and in `list_devices`. Both the relay and the local worker enforce it.

> **`system` is powerful and is not sandboxed.** Commands run with the full environment, credentials, filesystem permissions, and network access of the operating-system account that started Glossa. Commands are not confined to the selected project and can affect local or external systems.

## What Glossa enforces

- Structured file tools stay inside one selected root and reject absolute paths, parent traversal, and linked-path escapes.
- File changes require `workspace` or `system`; commands require an explicit `system` session.
- OAuth, account scoping, device credentials, and HTTPS protect the relay connection.
- The hosted relay keeps account, device, routing, and metadata-only audit records. It does not durably store file contents, command arguments, command output, environment variables, tokens, or local absolute paths.
- Press Ctrl+C or `q` in the worker terminal to disconnect immediately.

## Sensitive data

The public Glossa app is not intended for payment-card data subject to PCI DSS, protected health information, government identifiers, access credentials, or authentication secrets. Keep these categories out of the exposed project.

Glossa blocks recognizable authentication-secret patterns in text inputs and results. This can prevent common accidental disclosures, but it is not a complete data-loss-prevention system or sandbox. Unknown, encoded, encrypted, fragmented, or transformed values may not be recognized, and a command can send data over the network without printing it.

When credentials must be unreachable, run `system` in a credential-free dedicated operating-system account, container, or virtual machine with only the project and tools it needs.

## Safer use

- Start with the default `workspace` mode for ordinary code changes.
- Use `read-only` for inspection when no edits are needed.
- Enable `system` only for a task that needs the local toolchain.
- Expose a narrow project, never a home directory, filesystem root, credential store, or secrets directory.
- Stop the worker if the activity shown in the terminal is unexpected.

For implementation details and residual risks, read the [technical threat model](/docs/security). Data handling is described in the [privacy policy](/privacy).

## Report a security issue

Do not publish credentials, private source code, exploit details, or personal data. Use the [private security reporting process](https://github.com/ariobarin/glossa/security/advisories/new). See [support](/support) if private reporting is unavailable.
