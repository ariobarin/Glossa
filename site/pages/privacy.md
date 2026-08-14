# Privacy policy

Glossa routes requests between an authenticated ChatGPT or MCP client and a local project that you explicitly expose from your computer.

*Last updated August 14, 2026*

The public app is not intended for payment-card data subject to PCI DSS, protected health information, government identifiers, access credentials, or authentication secrets. See [Security and permissions](/security).

## Data Glossa processes

Glossa processes:

- Account identity supplied by Auth0.
- Device metadata such as a device ID, chosen name, platform, creation time, last-seen time, and revocation status.
- Active routing metadata such as an ephemeral worker ID, selected access profile, optional user-supplied label, worker version, capabilities, connection generation, and liveness state. Glossa does not derive or transmit a repository name or local absolute root.
- Metadata-only security audit records, limited to event type, status, timestamp, and related account or device identifiers.
- Tool requests and responses in transit, including relative paths, text file contents, command arguments, command input, and captured command output. Glossa may check text for recognizable authentication-secret patterns so it can block accidental disclosure.
- Network and service metadata processed by hosting and authentication providers, such as IP address, request time, client information, and error status.

## How data is used

Glossa uses this data to authenticate users, enroll devices, route requests, enforce the selected access profile, perform requested workspace operations, prevent abuse, diagnose failures, and maintain service security.

Glossa does not sell personal data, serve advertisements, or use workspace content to train models.

## Storage and retention

File contents, command arguments, command input, command output, local absolute paths, environment variables, OAuth access tokens, and device or worker bearer secrets are not intentionally written to Glossa's durable database. Request content remains in relay process memory only while an authenticated operation is queued or awaiting its result. It is removed when the operation completes or times out, the worker disconnects or reconnects, the device is revoked, or the relay process restarts. The relay is not a durable job queue.

Account, device, and audit metadata are retained for the life of the account or service, or until an account-deletion request is completed. Revoking a device prevents further use of its credential but does not by itself erase the device metadata. Glossa does not currently apply a shorter automatic expiration period to audit metadata.

Active worker IDs, profiles, labels, capabilities, command routes, pending jobs, command output, and liveness state are held only in relay memory. When recognizable authentication data is blocked, the matched content is not returned to the client.

The Glossa CLI stores OAuth and device credentials on the user's computer using the operating-system credential store when available. If that store is unavailable, the CLI warns before using a restricted local credential file.

## Service providers

Glossa relies on Auth0 for authentication, Heroku for the managed relay and database, and Vercel for the public website. GitHub and npm distribute the repository and CLI package. These providers process the data needed for their part of the service under their own terms and privacy practices.

ChatGPT or another connected MCP client receives the file contents, command details, and command output returned in response to its requests. That client processes and retains data under its own terms, privacy policy, workspace settings, and model-data controls.

## Your controls

- Choose `read-only`, `workspace`, or explicit `system` access for each worker.
- Stop the worker with Ctrl+C or `q`.
- Run `glossa unpair` to revoke this computer's device credential and remove its local copy.
- Run `glossa logout` to remove locally stored OAuth credentials and open browser sign-out.
- Disconnect Glossa in ChatGPT to revoke the client's authorization.
- Run `glossa devices revoke <id>` to invalidate an enrolled computer.
- Request device or account deletion through [support](/support).

## Security

The relay and worker independently enforce the selected access profile. `system` commands inherit the operating-system authority of the account that starts the worker and are not confined to the selected root. Read [Security and permissions](/security) before enabling commands.

## Children

Glossa is a developer tool and is not directed to children under 13. Do not use Glossa to submit personal data about a child who cannot legally consent to that processing.

## Changes and contact

Material changes will be published on this page with a new revision date. Questions and data requests can be started through [support](/support).
