# Support

Start with the [quickstart](/docs/quickstart). For reproducible bugs, setup problems, documentation corrections, and feature requests, use the public issue tracker.

<p class="docs-action-row"><a class="primary-action support-action" href="https://github.com/ariobarin/glossa/issues/new/choose">Open a GitHub issue</a></p>

## Common fixes

- **No online workspace:** keep the worker terminal open and confirm ChatGPT and the CLI use the same Glossa account.
- **Wrong workspace:** stop the worker and restart it in the intended project, optionally with a unique `--label`.
- **Permission error:** restart with broader access only when the task genuinely requires it. Do not try to bypass the selected profile.
- **`restricted_data_blocked`:** remove the credential from the request or reproduce the problem with a non-sensitive placeholder such as `<redacted>`. Do not retry with encoding, another tool, or a shell workaround.
- **Account mismatch:** stop workers, run `glossa logout`, disconnect Glossa in ChatGPT, and authorize both sides again with the intended account.
- **Tools changed:** run **Scan Tools** again after a Glossa update.

Before posting diagnostics, remove source code, local paths, account identifiers, tokens, credentials, and command output.

## Security reports

Do not put vulnerability details or sensitive data in a public issue. Use [GitHub's private vulnerability report](https://github.com/ariobarin/glossa/security/advisories/new). Include the affected version, impact, reproduction steps, and a safe way to contact you.

Read the [security overview](/security) for the current product boundary.

## Account and data requests

Open a minimal public issue titled `Account deletion request` without private identifiers. The operator will provide a private verification route before changing account data.

## Disconnect immediately

Press Ctrl+C or `q` in the worker terminal to end workspace access. Run `glossa logout` to remove local credentials and open browser sign-out. Disconnect Glossa in ChatGPT to revoke the client's authorization.
