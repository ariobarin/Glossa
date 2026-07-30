# API and protocol contract

All production endpoints use HTTPS.

## Public metadata

### `GET /.well-known/oauth-protected-resource`

Advertise `https://mcp.glossa.sh/` as the protected resource, along with the authorization server and the `glossa:access` scope. The protected-resource identifier is the OAuth audience. It is intentionally not the request URL `https://mcp.glossa.sh/mcp`.

### `GET /healthz`

No secret data. Suitable for uptime checks.

## User-authenticated control API

OAuth bearer token required. Audience must match the Glossa API. Routes check scopes and derive account ownership from `sub`.

### `POST /v1/devices/enroll`

Input:

```json
{
  "name": "Thomas MacBook",
  "platform": "darwin-arm64"
}
```

Output, shown once:

```json
{
  "device": {
    "id": "uuid",
    "name": "Thomas MacBook"
  },
  "device_token": "gld_uuid_secret"
}
```

### `GET /v1/devices`

Lists only the authenticated user's devices.

### `PATCH /v1/devices/:id`

Rename a device owned by the account.

### `DELETE /v1/devices/:id`

Revoke a device owned by the account.

## Worker API authentication

Register with the durable device credential:

```text
Authorization: Device gld_<device-id>_<secret>
```

A successful current registration returns an opaque `workerToken` bound to the worker ID and connection generation. Use it for poll, result, heartbeat, and unregister requests:

```text
Authorization: Worker glw_<random-256-bit-secret>
```

The relay stores only a SHA-256 digest in process memory and invalidates the credential when the worker reconnects, unregisters, is revoked, or becomes stale. Valid worker-authenticated traffic refreshes in-memory liveness immediately and coalesces the durable device `last_seen_at` update to at most once per minute. During rollout, current relays continue accepting the durable device credential on later endpoints, and current CLIs fall back to it when an older relay does not return `workerToken`.

### `POST /device/register`

Registers an active worker generation using an ephemeral worker UUID created by the CLI process and returns its generation plus the one-time `workerToken`. One enrolled device may register any number of workers. Reconnecting one worker replaces only that worker's generation and invalidates its previous worker credential. The request does not include the canonical local root or a derived repository name. It may include a validated `workspaceLabel` only when the user supplied `--label`; the relay retains that value with the active worker and does not persist it. Current workers advertise `commandProgress`, `concurrentJobs`, and `structuredReads` support. The relay returns the accepted capabilities, sends sequence-aware status jobs only to workers that accept them, enables capacity-aware concurrent delivery only after both sides negotiate it, and routes structured repository jobs only to workers that advertised them.

During a relay-first beta rollout, a current relay accepts structured-read, concurrent-capability, command-progress-only, worker-aware, and earlier single-worker request shapes. A current CLI retries those shapes in that order when it reaches an older relay. Concurrency remains disabled unless the registration response explicitly accepts `concurrentJobs`, and the MCP structured repository tools return `worker_update_required` unless the active worker advertised `structuredReads`. The single-worker compatibility mode supports one active workspace per enrolled device and reports worker counts as unavailable until the relay is updated.

### `POST /device/poll`

Includes the worker ID and generation. Waits no more than 18 seconds and returns one job or `204 No Content`. A worker with `concurrentJobs` may also send `acceptedTypes` and a shorter `waitMs`; the relay skips queued jobs outside the advertised capacity instead of allowing them to block control work. The current worker allows one command-status wait, one cancellation, two reads, and one mutation at a time, with five total in-flight jobs. `read_file`, `list_files`, `search_text`, and `read_file_range` share the read lane. `write_file`, `edit_file`, and `run_command` share the serialized mutation lane, while `cancel_command` remains independent from a long `get_command`. Older workers omit these fields and retain sequential delivery. Worker HTTP requests use a 19 second client timeout and reconnect with bounded exponential jitter.

### `POST /device/result`

Posts the worker ID and structured result for the delivered job. The relay acknowledges late results with `202` and `accepted: false`, discards them after caller timeout, and does not force older workers to reconnect.

### `POST /device/heartbeat`

Refreshes transient worker liveness while a delivered job is still running. This prevents a responsive worker from expiring merely because one local operation takes longer than the normal polling interval.

### `POST /device/unregister`

Removes one active worker during graceful shutdown. Abruptly disconnected workers expire from active routing state when their polling heartbeat becomes stale.

## MCP endpoint

### `POST /mcp`

OAuth required. The token's account can route only to devices owned by that account.

The origin route `POST /` serves the same authenticated transport for MCP clients that use their configured transport URL as the OAuth resource. This keeps the OAuth resource equal to the protected resource identifier `https://mcp.glossa.sh/`. The canonical protocol endpoint remains `https://mcp.glossa.sh/mcp`.

Tools:

- `list_devices`
- `logout`
- `read_file`
- `list_files`
- `search_text`
- `read_file_range`
- `write_file`
- `edit_file`
- `run_command`
- `get_command`
- `cancel_command`

`list_devices` returns an object with `product`, `documentationUrl`, `devices`, `availability`, and `message`. `product` gives the agent a stable, concise Glossa identity in both online and offline states. `documentationUrl` always links to the official setup and reconnect guide for the current deployment: the managed relay uses `https://glossa.sh/docs/quickstart`, while a custom relay uses `https://github.com/ariobarin/glossa/blob/main/docs/self-hosting.md`.

The result includes one device entry for every active worker. Its `deviceId` is the ephemeral worker identifier accepted by file and command tools, `name` is the enrolled computer name, and `workspaceLabel` is present only when the user explicitly supplied one. Each entry reports `path: "."`; local absolute paths and derived repository names are never returned. When no workers are active, `devices` is empty and `availability` is `"offline"`. The managed-relay `message` asks the agent to have the user open a terminal in the workspace they want to expose, run `glossa`, keep that terminal open, wait for the workspace to appear, and retry. A custom relay instead points the agent to the platform-specific worker command in the self-hosting guide. When one or more workers are active, `availability` is `"online"` and `message` confirms that workspaces are available. The offline result is a successful, user-safe response rather than a tool error. This preserves the existing MCP input name while allowing several independently routed workspaces on one enrolled computer. Local absolute paths are never transmitted to or returned by the hosted relay.

`logout` requires no worker. It returns the Auth0 browser logout URL and instructions that the model must present to the user. It does not navigate the browser, revoke credentials, or claim the user completed logout.

`list_files` returns at most 200 regular files or directories in deterministic global relative-path order, so cursor pagination cannot skip nested or sibling entries. On POSIX, discovered names containing literal backslashes use a `./` native-path prefix so the returned value can be passed unchanged to other path-based tools. It reads directory streams incrementally, never holds more than the 20,000-entry scan ceiling, never follows symlinks or junctions, and skips entries or child directories that become missing or inaccessible plus common dependency and version-control directories during recursive traversal. `nextCursor` is a separate native ordering key; pass it back unchanged as `cursor` so reusable path encoding cannot change pagination order. Callers should narrow `path` when the scan ceiling is reached.

`search_text` performs literal line-oriented matching without invoking a shell. It returns at most 100 matching lines with bounded 400-character snippets and scans at most 5,000 UTF-8 files, 32 MiB, or 20,000 filesystem entries. Files over 1 MiB, invalid UTF-8 files, links, transiently missing files, permission-denied files, and common dependency or version-control subtrees are skipped. Optional suffix filters support values such as `.ts` and `.d.ts`.

`read_file_range` returns at most 500 complete normalized lines and 64 KiB per call, together with the full-file SHA-256, total line count, and `nextLine` continuation metadata. The full file remains subject to the 1 MiB UTF-8 limit. Every structured repository job receives a worker-local deadline equal to at most half the hosted request window and never more than 8 seconds. After that deadline, the read lane remains occupied until the current filesystem operation settles, any late directory handle is closed, and the worker returns `scan_timeout`; this bounds stalled work instead of accumulating background I/O.

Tool annotations must describe actual behavior. `write_file`, `edit_file`, and `run_command` are non-read-only and destructive-capable.
Every tool advertises the `glossa:access` OAuth scheme in descriptor metadata and is visible to the model. `run_command` declares `openWorldHint: true` because a command can use the worker account's inherited network access and affect external systems. All other tools declare `openWorldHint: false`.
Tool descriptions state when the model should select each operation. Every public input and output field includes a description, and successful results provide both structured content and an equivalent JSON text fallback.

## Worker job union

```ts
type WorkerJob =
  | { type: "read_file"; requestId: string; path: string }
  | {
      type: "list_files";
      requestId: string;
      path?: string;
      recursive?: boolean;
      cursor?: string;
      limit?: number;
      timeoutMs: number;
    }
  | {
      type: "search_text";
      requestId: string;
      query: string;
      path?: string;
      caseSensitive?: boolean;
      maxResults?: number;
      extensions?: string[];
      timeoutMs: number;
    }
  | {
      type: "read_file_range";
      requestId: string;
      path: string;
      startLine?: number;
      lineCount?: number;
      timeoutMs: number;
    }
  | {
      type: "write_file";
      requestId: string;
      path: string;
      content: string;
      expectedSha256?: string;
    }
  | {
      type: "edit_file";
      requestId: string;
      path: string;
      edits: Array<{ oldText: string; newText: string }>;
      expectedSha256?: string;
    }
  | {
      type: "run_command";
      requestId: string;
      argv?: string[];
      shellCommand?: string;
      stdin?: string;
      timeoutMs: number;
      waitMs?: number;
    }
  | {
      type: "get_command";
      requestId: string;
      commandId: string;
      afterSequence?: number;
      waitMs?: number;
    }
  | { type: "cancel_command"; requestId: string; commandId: string };
```

`argv` and `shellCommand` are mutually exclusive.

An active worker executes valid `write_file`, `edit_file`, and bounded `run_command` jobs without a separate local confirmation round trip. Session startup is the local authorization boundary. File tools remain confined to the exposed root. Commands retain the full authority and permissions of the local worker account.

`edit_file` applies one or more exact old-text/new-text replacements against the same original file. Every old-text value must be non-empty and occur exactly once, replacements may not overlap, and the worker always guards the final atomic write with the hash of the file it read. The optional caller-provided SHA-256 adds an earlier stale-revision check. A successful result returns the new hash, replacement count, and a bounded unified diff of the affected lines.

Command processes inherit the complete environment of the Glossa worker process. Glossa does not enumerate or transmit that environment unless a user-authorized command explicitly reads or prints part of it.

`run_command` waits up to 750 milliseconds by default for fast completion, configurable from 0 through 5,000 milliseconds. A command that finishes within that budget returns its terminal status and bounded output in the same tool call; a longer command returns the worker `deviceId`, a running `commandId`, captured output so far, and a monotonic `sequence` when the worker supports incremental progress. `get_command` and `cancel_command` require both IDs, so the relay routes command control directly instead of retaining a command-to-worker lookup. `get_command` may wait up to 15 seconds. Passing the latest `sequence` as `afterSequence` makes that wait end when new output arrives or lifecycle state changes; omitting it preserves completion-oriented waiting for compatibility. Results report `running`, `succeeded`, `failed`, `canceled`, or `timed_out` and include bounded output captured so far. Public MCP results omit worker-local lifecycle timestamps because clients do not need them to manage a command. `cancel_command` terminates the process tree. Disconnecting the worker rejects new jobs and terminates an active command. Command state, worker IDs, sequences, and output remain transient and are never persisted by the relay.

Full text-file reads and writes are limited to 1 MiB. Structured listings, searches, and ranged reads have the smaller per-call and scan ceilings described above. Returned standard output and standard error share a 12 KiB command-result budget. Each local stream retains a bounded beginning and rolling tail, then the worker allocates the response budget across both streams so noisy standard output cannot erase all diagnostic standard error. A truncated stream therefore preserves useful context from both ends and sets its truncation flag; clients can still use a narrower follow-up command when more detail is needed. One command may run at a time per worker; another `run_command` request returns `command_busy` until the active command finishes or is canceled.

The requested command timeout defaults to 900,000 milliseconds and must be between 1 millisecond and the 3,600,000 millisecond hard maximum.

These are ordinary MCP tools so clients do not need native MCP Tasks support. Native task negotiation may be added after target client support is dependable, but it is not part of the core MVP contract.

## Error principles

- Return stable machine-readable codes.
- Do not include local absolute paths in hosted errors.
- Distinguish offline, timeout, stale revision, absent or ambiguous edit targets, overlapping edits, output truncated, and command spawn failure.
- Authentication errors disclose no device/account existence.
