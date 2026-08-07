# How can we help?

Use the public issue tracker for setup problems, reproducible bugs, documentation corrections, and feature requests.

## Before opening an issue

- Read the [quickstart](/docs/quickstart) for installation and first use.
- Confirm the worker terminal is open and shows the expected workspace and access profile.
- Run `glossa status` in another terminal to validate the account, relay, enrolled devices, and active workers.
- Remove source code, local paths, account identifiers, tokens, credentials, and command output from diagnostics.

<p class="docs-action-row"><a class="primary-action support-action" href="https://github.com/ariobarin/glossa/issues/new/choose">Open a GitHub issue</a></p>

## Security reports

Do not put vulnerability details, credentials, private source code, or personal data in a public issue. Use [GitHub's private vulnerability report](https://github.com/ariobarin/glossa/security/advisories/new). Include the affected version, impact, reproduction steps, and a safe way to contact you. If that private form is unavailable, open a minimal public issue titled `Security contact request` with no sensitive details.

Read the [security overview](/security) and [technical threat model](/docs/security) for the current boundaries and known limits.

## Account and data requests

To request account or device deletion, open a minimal issue titled `Account deletion request`. Do not include an email address, Auth0 subject, device token, access token, local path, or other private identifier. The operator will provide a private verification route before changing account data.

## Immediate disconnect

Press Ctrl+C or `q` in the worker terminal to end workspace access. Run `glossa logout` to sign out locally and in the browser. Disconnect Glossa in ChatGPT to revoke client authorization.
