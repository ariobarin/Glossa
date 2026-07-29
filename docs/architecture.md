# Core architecture

## Topology

```text
OAuth-capable MCP client
        |
        | HTTPS + OAuth access token
        v
hosted relay
  +-- OAuth token verification
  +-- MCP adapter
  +-- account and device routing
  +-- in-memory jobs
  +-- metadata persistence in Postgres
        ^
        | HTTPS + device credential at registration
        | ephemeral worker credential for repeated polling
        |
glossa process on user device
  +-- canonical root
  +-- linked-path enforcement
  +-- atomic file operations
  +-- bounded one-shot commands
```

## Why the relay stays small

The relay must be publicly reachable, while the user's computer makes outbound connections only. One hosted relay process supplies the rendezvous point and OAuth-protected MCP endpoint. Postgres stores identity and lifecycle metadata. Active routing state remains in memory.

Users do not operate networking, identity, or database infrastructure.

## Identity planes

### MCP client identity

The authorization server handles discovery, login, consent, and access tokens. The relay validates issuer, audience, expiry, and the `glossa:access` scope. It atomically creates an account for a new authenticated subject and rejects accounts marked disabled.

The managed service accepts only Auth0 subjects from the Google social connection. The relay enforces the configured subject prefix in addition to JWT validation, so enabling another connection in Auth0 does not grant it Glossa access. Self-hosted relays explicitly select their own allowed Auth0 subject prefix.

### CLI user identity

The published CLI uses OAuth Device Authorization Flow. Its embedded client ID is public. The CLI requests `openid profile offline_access glossa:device`.

The managed Auth0 Google connection requests Google's account chooser on every new authorization. This lets a user choose among multiple Google accounts instead of silently reusing a browser session.

### Worker device identity

After user login, the CLI calls the device-enrollment API. The server returns a device token once:

```text
gld_<device-id>_<random-256-bit-secret>
```

The database stores the device ID, account ID, salt, and scrypt hash. Worker registration authenticates the device token over HTTPS, then returns an opaque worker credential bound to that worker ID and connection generation. Poll, result, heartbeat, and unregister requests use the in-memory worker credential, avoiding repeated database and scrypt work. The relay coalesces durable `last_seen_at` updates to at most once per minute per enrolled device while keeping second-scale liveness in memory. One device can be revoked without affecting the user's other devices or MCP authorizations; revocation removes every active worker credential for that device.

The CLI binds each locally stored device credential to the subject in the
current Auth0 access token. Normal startup can therefore reject an account
switch locally and let worker registration validate the device token without a
separate device-list request. A legacy unbound credential receives one
account-scoped ownership check before the CLI saves that binding.

## State ownership

### Postgres

- accounts
- devices and revocation
- device names
- schema migrations
- metadata-only audit events

The canonical database schema is [`apps/relay/sql/001_init.sql`](../apps/relay/sql/001_init.sql). Every resource lookup includes the authenticated account ID.

### Relay memory

- active worker connections
- device IDs, ephemeral worker IDs, connection generations, optional user-chosen workspace labels, hashed worker credentials, and coalesced presence timestamps, without local absolute paths
- pending jobs
- request waiters
- recent nonces and bounded rate-limit counters

### Worker

- exposed canonical root
- path enforcement
- local process execution
- complete inherited local environment and developer credentials
- temporary active command state

One enrolled device may run any number of concurrent workers. Each worker receives an ephemeral ID for its process lifetime, so requests remain bound to one exposed root without persisting that root or a derived repository name. A user may explicitly add a workspace label for client-side selection; the relay keeps it only with the active worker and never derives it from the local path. Current workers also negotiate bounded concurrent job delivery: command status, cancellation, reads, and mutations use separate local capacity lanes, while older workers remain sequential.

## Hosted request deadlines

The hosting layer imposes a bounded request window. Therefore:

- worker long polls return within 20 seconds; a worker with concurrent jobs negotiated uses shorter capacity-aware polls while local jobs are active;
- relay database connections remain reusable across worker poll intervals, and new connection attempts fail within 5 seconds;
- durable device authentication occurs at registration, while repeated worker requests use process-local credentials and coalesced metadata writes;
- `run_command` returns after the worker accepts the command and supplies the worker ID and command ID;
- command execution continues locally beyond the initiating request;
- later command calls carry both IDs, so relay restarts do not lose a command routing lookup;
- `get_command` may wait up to 15 seconds and can wake as soon as command output or status changes;
- `cancel_command` uses a separate bounded request;
- no hosted request remains open for the lifetime of a command.

The core protocol uses ordinary MCP tools for command start, status, result, and cancellation. Native MCP Tasks support is deferred until target clients support it dependably.

## Deployment scale

Use exactly one relay process while active routing state is process-local. Do not scale horizontally until routing has an external coordination design.

## Local development

Local development may use loopback relay and worker origins. It must still exercise OAuth authentication and the same account and device ownership checks as production.
