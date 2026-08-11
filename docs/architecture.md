# Core architecture

## Topology

```text
OAuth-capable MCP client
        |
        | HTTPS + OAuth access token
        v
hosted relay
  +-- OAuth token verification
  +-- MCP adapter and exact tool contracts
  +-- account, device, and worker routing
  +-- access-profile permission gate
  +-- in-memory jobs
  +-- metadata persistence in Postgres
        ^
        | HTTPS + device credential at registration
        | ephemeral worker credential for repeated polling
        |
glossa process on user device
  +-- canonical root and visible access profile
  +-- independent permission enforcement
  +-- linked-path enforcement
  +-- atomic file operations
  +-- optional bounded commands under system access
```

## Why the relay stays small

The relay must be publicly reachable, while the user's computer makes outbound connections only. One hosted relay process supplies the rendezvous point and OAuth-protected MCP endpoint. Postgres stores identity and lifecycle metadata. Active routing state remains in memory.

Users do not operate networking, identity, or database infrastructure.

## Identity planes

### MCP client identity

The authorization server handles discovery, login, consent, and access tokens. The relay validates issuer, audience, expiry, and the `glossa:access` scope. It atomically creates an account for a new authenticated subject and rejects accounts marked disabled. Already-admitted accounts use a lock-only `SELECT FOR NO KEY UPDATE`, avoiding a new account row version on every authenticated request while retaining the original queue ordering and serialization with direct operator updates to `disabled_at`. The admission upsert runs only for a new subject, a legacy active account whose admission timestamp is absent, or a concurrent-create race.

The managed service uses the Google social connection for regular users and can explicitly enable a dedicated Auth0 database connection for OpenAI review. The relay enforces a bounded provider-prefix allowlist plus an optional exact-subject allowlist in addition to JWT validation. Managed review keeps Google as the only provider-wide prefix and admits only the dedicated database reviewer's exact Auth0 subject, so enabling the connection does not admit every database identity. Production review credentials and the exact subject are manually provisioned, independent of operator accounts, and excluded from source control. Self-hosted relays may select provider prefixes, exact subjects, or both; the legacy singular prefix setting remains compatible.

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
- device IDs, ephemeral worker IDs, connection generations, selected access profiles, optional user-chosen workspace labels, hashed worker credentials, and coalesced presence timestamps, without local absolute paths
- pending jobs after relay-side profile and recognizable-authentication-secret input checks
- request waiters
- recent nonces and bounded rate-limit counters

### Worker

- exposed canonical root
- selected `read-only`, `workspace`, or `system` profile
- local permission enforcement independent of the relay
- path enforcement and atomic structured file operations, including guarded directory creation, deletion, and moves without command authority
- local process execution only under `system`
- complete inherited local environment, credentials, operating-system permissions, and network access only when a system command is started
- high-confidence authentication-secret input and result checks, including bounded per-stream command scan tails and every retained output window
- temporary command state, including at most 1 MiB of independently retained stdout and stderr per record for bounded range retrieval, with terminal records limited to five minutes and eight recent records

One enrolled device may run concurrent workers for different roots. Before login or relay connection, the current CLI reserves a user-local IPC endpoint derived from a one-way hash of the canonical root and rejects another current process for that same root. The kernel releases the live listener when a process exits; Unix stale socket files are probed and cleaned under a short acquisition guard. No root path is sent to or persisted by the relay. Each worker receives an ephemeral ID for its process lifetime, so requests remain bound to one exposed root without persisting that root or a derived repository name. A user may explicitly add a workspace label for client-side selection; the relay keeps it only with the active worker and never derives it from the local path.

Current workers report their CLI package version, selected access profile, and bounded capability flags. The relay echoes the accepted profile during registration and exposes the profile plus derived `readFiles`, `writeFiles`, and `runCommands` booleans only as active routing metadata. Before queueing a job, the relay rejects writes when `writeFiles` is false, command lifecycle operations when `runCommands` is false, and recognizable authentication-secret material in mutation or command inputs. The worker repeats the permission and restricted-input checks locally and suppresses recognizable credential material in content-bearing results. A profile-less legacy worker is conservatively classified as `system`, matching its historical command authority rather than presenting it as safer than it is.

Current workers also negotiate bounded concurrent job delivery, structured repository reads, structured path mutations, and retained command-output ranges. Command status, retained output reads, cancellation, repository reads, and mutations use separate local capacity lanes; file listing, bounded text search, and ranged reads share the bounded read lane, while file writes, edits, directory creation, deletion, moves, and command starts share the serialized mutation lane. Text search supports literal or regex matching plus root-relative include/exclude globs, uses directory-entry type metadata to avoid a redundant metadata syscall for regular files and directories, and still resolves each discovered directory or file through the linked-path policy before traversing or reading it. Older workers remain sequential and are never sent structured-read, structured-mutation, or command-output-range jobs they did not advertise.

## Request profiling

Set `GLOSSA_TIMING_LOGS=1` to emit one metadata-only JSON timing event after each handled relay route response. Events contain only a bounded operation label, HTTP status, and total relay duration. MCP operation labels include only known tool names; device identifiers, paths, command arguments, output, tokens, account identifiers, and request bodies are never logged. Requests rejected by application-level parsing before route handling are outside this timing boundary. Profiling is disabled by default and adds no response listener on the hot path when disabled.

## Hosted request deadlines

The hosting layer imposes a bounded request window. Therefore:

- worker long polls return within 20 seconds; when a concurrent lane becomes free, the worker supersedes a stale capacity poll with a one-shot refresh for only the newly available job types;
- relay database connections remain reusable across worker poll intervals, and new connection attempts fail within 5 seconds;
- durable device authentication occurs at registration, while repeated worker requests use process-local credentials and coalesced metadata writes;
- `run_command` is available only to a worker registered with `system` access and returns after that worker accepts the command and supplies the worker ID and command ID;
- command execution continues locally beyond the initiating request unless cancellation, timeout, disconnect, or recognizable authentication-secret output triggers process-tree termination;
- command follow-ups always carry both the worker ID and command ID, so routing is explicit and remains valid across relay restarts;
- `get_command` accepts waits up to 15 seconds and can wake as soon as command output or status changes; the relay reserves five seconds of its configured request deadline for queueing, delivery, result handling, and the hosted HTTP response, shortening the worker-side wait when necessary;
- `read_command_output` returns at most 64 KiB of one retained stream per request, reports a continuation offset, and never reruns the command;
- `cancel_command` uses a separate bounded request;
- structured repository reads use a worker-local deadline of at most half the relay request window and 8 seconds; after expiry, the read lane stays occupied until the active filesystem operation settles and any late directory handle is closed;
- a result arriving after caller timeout receives a successful `accepted: false` acknowledgement and is discarded without forcing old or current workers to reconnect;
- no hosted request remains open for the lifetime of a command.

The core protocol uses ordinary MCP tools for command start, status, retained output retrieval, result, and cancellation. Native MCP Tasks support is deferred until target clients support it dependably.

## Deployment scale

Use exactly one relay process while active routing state is process-local. Do not scale horizontally until routing has an external coordination design.

## Local development

Local development may use loopback relay and worker origins. It must still exercise OAuth authentication and the same account and device ownership checks as production.
