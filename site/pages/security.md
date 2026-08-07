# Your worker controls workspace access.

Glossa does not upload or synchronize the selected folder as a stored repository. The local worker performs requested file operations and, only under the `system` profile, local commands. File contents, command details, and results are transmitted through the encrypted relay to the authenticated client while a request is active.

## Choose the least authority

| Profile | Reads | Writes inside the root | Commands |
| --- | --- | --- | --- |
| `read-only` | Yes | No | No |
| `workspace` (default) | Yes | Yes | No |
| `system` | Yes | Yes | Yes |

The selected profile is shown in the local terminal and returned by `list_devices`. Both the relay and local worker reject operations outside that profile.

> **System access is powerful.** Commands run with the full environment, credentials, filesystem permissions, and network access of the operating-system account that launched Glossa. File boundaries do not turn commands into a sandbox, and commands can reach files outside the exposed root.

## What you authorize

- You choose one local directory and one access profile when starting Glossa.
- Structured file tools remain inside the selected root and reject links and traversal.
- File changes require `workspace` or `system` access.
- Commands require an explicit `glossa --access system` session.
- Press Ctrl+C or `q` in the worker terminal to disconnect.

## What the relay stores

The hosted relay keeps account, device, routing, and metadata-only audit records needed to operate and secure the service. It does not durably store file contents, command arguments, command output, environment variables, tokens, or local absolute paths.

## How boundaries are enforced

- The relay checks the worker's declared permissions before queueing each operation.
- The local worker independently enforces the same profile before touching files or starting a process.
- Path containment, canonicalization, and link checks are enforced locally for every structured file operation.
- Every relay resource is scoped to the authenticated account.
- The relay stores only salted hashes of random device secrets.
- Recoverable local credentials use the operating-system credential store, with an explicit warning before a restricted file fallback.
- Hosted logs contain operational metadata rather than request or response content.

## Use Glossa safely

- Start with `read-only` for review and diagnosis.
- Use the default `workspace` profile for scoped file changes that do not require commands.
- Enable `system` only for tasks that need the local toolchain.
- Never expose a home directory, filesystem root, credential store, or secrets directory.
- Use a dedicated operating-system account, container, or virtual machine when stronger isolation is required.
- Stop the worker immediately if activity is unexpected.

## Report a security issue

Do not publish credentials, private source code, exploit details, or personal data. Follow the [private security reporting process](https://github.com/ariobarin/glossa/security/advisories/new). See the [support page](/support) if private reporting is unavailable.

Maintainers and reviewers can read the complete [threat model and controls](/docs/security).
