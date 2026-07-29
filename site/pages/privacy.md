# Privacy policy

Glossa routes requests between an authenticated ChatGPT or MCP client and a workspace that you explicitly expose from your own computer.

*Last updated July 15, 2026*

## Data Glossa processes

Glossa processes the following categories of data to operate and secure the service:

- Account identity, represented by the subject identifier supplied by Auth0.
- Device metadata, including a device ID, chosen name, platform, creation time, last-seen time, and revocation status.
- Security audit metadata, limited to event type, status, timestamp, and related account or device identifiers.
- Tool requests and responses in transit, including relative file paths, text file contents, command arguments, command input, and captured command output.
- Network and service metadata processed by hosting and authentication providers, such as IP address, request time, browser or client information, and error status.

## How data is used

Glossa uses this data only to authenticate users, enroll and route requests to devices, perform requested workspace operations, prevent abuse, diagnose service failures, and maintain service security. Glossa does not sell personal data, serve advertisements, or use workspace content to train models.

## Storage and retention

File contents, command arguments, command input, command output, local absolute paths, environment variables, OAuth access tokens, and device bearer secrets are not intentionally written to Glossa's durable database. Request content is held temporarily in process memory while a job is queued or routed. It leaves the relay queue when delivered. An undelivered request remains in memory until the worker registers again, the device is revoked, or the relay process restarts. A client timeout or local worker exit does not itself remove a queued request. Registering the worker again discards the prior queue.

Account, device, and audit metadata are retained for the life of the account or service, or until an account-deletion request is completed. Revoking a device prevents further use of its credential but does not by itself erase its metadata. Glossa does not currently apply a shorter automatic expiration period to audit metadata.

The Glossa CLI stores OAuth and device credentials on the user's computer using the operating-system credential store when available. If that store is unavailable, the CLI warns before using a restricted local credential file.

## Service providers

Glossa relies on Auth0 for authentication, Heroku for the managed relay and database, and Vercel for the public website. These providers process the data needed to supply their part of the service under their own terms and privacy practices. GitHub and npm distribute the open-source repository and CLI package but do not receive workspace requests through Glossa.

The ChatGPT app, plugin, or other MCP client that you connect receives the file contents, command details, and command output returned in response to its requests. That client processes and retains data under its own terms, privacy policy, workspace settings, and model-data controls. Glossa's statement that it does not train models on workspace content applies only to Glossa.

## User controls

- Stop the local `glossa` process to end useful workspace access immediately.
- Run `glossa logout` to remove locally stored OAuth credentials and sign out in the browser.
- Disconnect the Glossa app or plugin in ChatGPT to revoke the client's authorization.
- Request device or account deletion through the [support page](/support). Do not post private identifiers or credentials in a public issue.

## Security

Glossa uses HTTPS, OAuth access-token validation, per-device credentials stored as salted hashes, account-scoped database queries, bounded requests, and local path checks. Command execution still has the full authority and environment of the operating-system account that starts the worker. File-root checks do not sandbox shell commands. Review the public [security model](/security) before use.

## Children

Glossa is a developer tool and is not directed to children under 13. Do not use Glossa to submit personal data about a child who cannot legally consent to that processing.

## Changes and contact

This policy may change when Glossa's behavior, providers, or legal obligations change. Material changes will be published on this page with a new revision date. Questions and data requests can be started through the [support page](/support).
