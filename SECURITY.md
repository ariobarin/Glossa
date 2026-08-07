# Security policy

## Supported versions

Security fixes are applied to the current stable CLI and managed relay. Reproduce issues against the newest published stable version when it is safe to do so.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/ariobarin/glossa/security/advisories/new). Do not include vulnerability details, credentials, tokens, private source code, personal data, or local paths in a public issue.

A useful report includes:

- the affected Glossa version or managed endpoint;
- the access profile in use;
- impact and prerequisites;
- minimal reproduction steps using non-sensitive fixtures;
- whether the issue affects the relay, CLI, website, OAuth flow, or documentation;
- a safe contact method.

If the private form is unavailable, open a public issue titled `Security contact request` without sensitive details. A maintainer will establish a private channel before requesting more information.

## Security boundary

Structured file tools are confined to the explicitly selected workspace root. `system` access is different: commands inherit the worker operating-system account's environment, credentials, filesystem permissions, and network access and are not confined to the root. This documented authority is not itself a vulnerability. Report cases where the implementation exceeds the selected profile, crosses account boundaries, leaks durable content, bypasses authentication, or contradicts the published security model.

See [`docs/security.md`](docs/security.md) for the threat model and controls.
