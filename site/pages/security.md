# Your worker controls workspace access.

Glossa does not copy your selected folder into the hosted relay. The local worker reads files and runs commands. Requested file contents, command details, and command results are transmitted through the relay to the connected client.

> **Command access is powerful.** Commands run with the full environment and permissions of the operating-system account that launched Glossa. File boundaries do not turn shell commands into a sandbox.

## What you authorize

- You choose one local directory when you start Glossa.
- Connected clients can read and modify files inside that root.
- Connected clients can run commands with the worker account's authority.
- Press Ctrl+C in the worker terminal to start disconnecting. The worker is disconnected when the process exits.

## What the relay stores

The hosted relay keeps only account, device, routing, and metadata-only audit records needed to operate the service. It does not durably store file contents, command arguments, command output, environment variables, tokens, or local absolute paths.

## How boundaries are enforced

- Path containment and process controls are enforced on the local worker.
- Every relay resource is scoped to the authenticated account.
- The relay database stores only salted hashes of random device secrets.
- The worker keeps its recoverable device secret in the operating-system credential store, or uses a warned local file fallback whose access controls depend on the operating system.
- Hosted logs contain operational metadata rather than request or response content.

## Use Glossa safely

- Start with a folder you can safely test.
- Never expose your home directory, a filesystem root, or a folder containing credentials.
- Run the worker under a dedicated operating-system account when you need a stronger boundary.
- Use a container or virtual machine when operating-system isolation is required.

## Report a security issue

Do not publish credentials, private source code, exploit details, or personal data. Follow the private-contact process on the [support page](/support).

Maintainers and reviewers can read the complete [threat model and controls](/docs/security).
