# How can we help?

Use the public issue tracker for setup problems, reproducible bugs, documentation corrections, and feature requests.

## Before opening an issue

- Read the [quickstart](/docs/quickstart) for installation and first use.
- Confirm the worker terminal is still open and shows the expected workspace root.
- Run `glossa status` in another terminal to validate the account, relay access, enrolled devices, and active workers.
- Remove source code, local paths, account identifiers, tokens, and credentials from any diagnostic details.

<p class="docs-action-row"><a class="primary-action support-action" href="https://github.com/ariobarin/glossa/issues/new">Open a GitHub issue</a></p>

## Security reports

Do not publish credentials, private source code, exploit details, or personal data in a GitHub issue. Open a minimal issue titled `Security contact request` without sensitive details so the operator can provide a private follow-up route.

For the current trust boundaries and known limits, read the [Glossa security page](/security).

## Account and data requests

To request account or device deletion, open a minimal issue titled `Account deletion request`. Do not include an email address, Auth0 subject, device token, access token, local path, or other private identifier. The operator will provide a private verification route before changing account data.

## Immediate disconnect

Press Ctrl+C in the worker terminal to end useful workspace access. Run `glossa logout` to sign out locally and in the browser. Disconnect the Glossa app or plugin in ChatGPT to revoke client authorization.
