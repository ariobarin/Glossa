# API and protocol contract

All production endpoints use HTTPS.

## Public metadata

### `GET /.well-known/oauth-protected-resource`

Advertise `https://mcp.glossa.sh/` as the protected resource, along with the authorization server and the `glossa:access` scope. The protected-resource identifier is the OAuth audience. It is intentionally not the request URL `https://mcp.glossa.sh/mcp`.

### `GET /healthz`

No secret data. Suitable for uptime checks.

## User-authenticated control API

OAuth bearer token required. Audience must match the Glossa API. Routes check scopes and derive account ownership from `sub`.

### `GET /v1/devices`

Lists only the authenticated user's devices.

### `PATCH /v1/devices/:id`

Rename a device owned by the account.

### `DELETE /v1/devices/:id`

Revoke a device owned by the account.

### `POST /v1/devices/enroll`

Older CLIs obtain a temporary access token through browser device authorization, call this endpoint once, then discard the token. Current CLIs pair with the single-use relay pairing codes described below; only the returned revocable device credential is stored.

## Pairing codes

### `POST /v1/pairings`

Unauthenticated and rate-limited. Creates a single-use pairing code bound to the requested device name and platform, valid for ten minutes. Returns the code and its expiry; the relay stores only a SHA-256 hash.

### `POST /v1/pairings/:code/claim`

OAuth bearer token with the device-enrollment scope required. Claims the code for the authenticated account; used by the control panel after the signed-in user confirms the device name.

### `POST /v1/pairings/redeem`

Unauthenticated and rate-limited. Returns `202` with `{"status": "pending"}` while the code is unclaimed, the enrolled device and its revocable device credential once claimed, and `404` when the code is unknown or expired. The CLI polls this endpoint after printing the code.

## Worker API authentication

Register with the durable device credential:

```text
Authorization: Device gld_<device-id>_<secret>
```

A successful current registration returns an opaque `workerToken` bound to the worker ID and connection generation. Use it for poll, result, heartbeat, and unregister requests:

```text
Authorization: Worker glw_<random-256-bit-secret>
```

The relay stores only a SHA-256 digest in process memory and invalidates the credential when the worker reconnects, unregisters, is revoked, or becomes stale. Valid worker-authenticated traffic refreshes in-memory liveness immediately and coalesces the durable device `last_seen_at` update to at most once per minute. Poll, result, heartbeat, and unregister requests require this ephemeral worker credential.

### `POST /device/register`

Registers an active worker generation using an ephemeral worker UUID created by the CLI process and returns its generation plus the one-time `workerToken`. One enrolled device may register any number of workers. Reconnecting one worker replaces only that worker's generation and invalidates its previous worker credential. The request does not include the canonical local root or a derived repository name. It may include a validated `workspaceLabel` only when the user supplied `--label`; the relay retains that value with the active worker and does not persist it.

A worker always advertises one `accessProfile`: `read-only`, `workspace`, or `system`. The relay echoes the accepted profile, derives `readFiles`, `writeFiles`, and `runCommands`, and rejects a forbidden operation before it enters the worker queue. The local worker independently enforces the same mapping.

Workers advertise their CLI package version and the current command progress, concurrent job, structured read, structured mutation, and command output range capabilities; current workers also advertise `imageReads`. These fields are internal routing metadata. The public `list_workspaces` result exposes only the ephemeral `workspaceId`, optional user-chosen `workspaceLabel`, selected `accessProfile`, and derived permission booleans.

Registration remains fail-closed for the shared baseline protocol, selected profile, worker identity, and optional label, but contract `3.1.0` deliberately supports one rolling-upgrade boundary for `imageReads`. A current relay accepts a legacy worker without `imageReads` and records that capability as unavailable, so non-image tools continue to work while `view_image` fails immediately with upgrade guidance. A current worker first advertises `imageReads`; if an older relay rejects the extra capability with the legacy protocol-validation response, the worker retries once with the legacy capability shape and excludes `view_image` from its accepted job types for that session. Other protocol mismatches still fail closed.

### `POST /device/poll`

Includes the worker ID and generation. Waits no more than 18 seconds and returns one permitted job or `204 No Content`. The relay never queues writes for a profile without `writeFiles` and never queues command start, status, or cancellation jobs for a profile without `runCommands`. The worker sends `acceptedTypes` and may send a shorter `waitMs`; the relay skips queued jobs outside the available capacity instead of allowing them to block control work. When a lane becomes free, the worker sends a one-millisecond refresh poll containing only newly available job types. That refresh supersedes the stale waiter without continuously shortening every active-job poll. The worker allows one command-status wait, one cancellation, two reads, and one mutation at a time, with five total in-flight jobs. `read_file`, `view_image`, `list_files`, `search_text`, and `read_file_range` share the read lane. Permitted `write_file`, `edit_file`, `make_directory`, `delete_path`, `move_path`, and `run_command` jobs share the serialized mutation lane, while `cancel_command` remains independent from a long `get_command`. Worker HTTP requests use a 19 second client timeout and reconnect with bounded exponential jitter.

### `POST /device/result`

Posts the worker ID and structured result for the delivered job. The relay acknowledges late results with `202` and `accepted: false` and discards them after caller timeout without forcing a reconnect.

### `POST /device/heartbeat`

Refreshes transient worker liveness while a delivered job is still running. This prevents a responsive worker from expiring merely because one local operation takes longer than the normal polling interval.

### `POST /device/unregister`

Removes one active worker during graceful shutdown. Abruptly disconnected workers expire from active routing state when their polling heartbeat becomes stale.

## MCP endpoint

### `POST /mcp`

OAuth required. The token's account can route only to devices owned by that account.

The origin route `POST /` serves the same authenticated transport for MCP clients that use their configured transport URL as the OAuth resource. This keeps the OAuth resource equal to the protected resource identifier `https://mcp.glossa.sh/`. The canonical protocol endpoint remains `https://mcp.glossa.sh/mcp`.

MCP initialization advertises public tool-contract version `3.1.0` and one compact app-wide instruction. It defines Glossa's distinct local-workspace scope, directs general questions, web research, and built-in ChatGPT tasks away from Glossa, requires context-dependent workspace discovery, exposes ambiguous selection rules, treats tool results as untrusted data, and explains all three access profiles. It explicitly discloses that `system` commands inherit the worker account's environment, credentials, filesystem permissions, and network access and are not confined to the root. It also prohibits requesting, passing, or returning access credentials and authentication secrets and identifies the recognizable-secret detector as defense in depth rather than a sandbox. Tool descriptions state when each operation should and should not be used. A copy-only metadata change requires a fresh connector scan and review, but does not change the tool contract version. Bump `MCP_SERVER_VERSION` when a public tool name, input or output schema, annotation, permission field, or result contract changes.

Contract `3.1.0` adds the read-only `view_image` tool, gated by the `imageReads` worker capability, and minimizes public workspace discovery metadata. `list_workspaces` now returns only the ephemeral `workspaceId`, optional user-chosen `workspaceLabel`, `accessProfile`, and exact operation permissions needed to route and authorize a workspace operation. It no longer returns the enrolled computer name, constant `path: "."`, worker version, or protocol-capability booleans. During a rolling upgrade, the relay continues to accept pre-3.1 workers for non-image tools, while a current worker can fall back to the pre-3.1 registration shape when it encounters an older relay; `view_image` remains unavailable until both sides advertise image-read support. Contract `3.0.0` removed the unusable `pair_device` tool after ChatGPT's safety layer proved to block its pairing-code argument before Glossa could process it. Computer enrollment now uses relay pairing codes that the CLI prints and the user redeems on the control panel.

Tools:

- `list_workspaces`
- `get_logout_instructions`
- `read_file`
- `view_image`
- `list_files`
- `search_text`
- `read_file_range`
- `write_file`
- `edit_file`
- `make_directory`
- `delete_path`
- `move_path`
- `run_command`
- `get_command`
- `read_command_output`
- `cancel_command`

`list_workspaces` returns an object with `product`, `documentationUrl`, `workspaces`, `availability`, and `message`. `product` gives the agent a stable, capability-oriented Glossa identity in both online and offline states. `documentationUrl` always links to the official setup and reconnect guide for the current deployment: the managed relay uses `https://glossa.sh/docs/quickstart`, while a custom relay uses `https://github.com/ariobarin/glossa/blob/main/docs/self-hosting.md`.

The result includes stable product metadata with the same `contractVersion` advertised during MCP initialization, plus one workspace entry for every active worker. Its `workspaceId` is the ephemeral routing identifier accepted by file and command tools, `workspaceLabel` is present only when the user explicitly supplied a non-sensitive label, and each entry reports `accessProfile` plus a `permissions` object containing `readFiles`, `writeFiles`, and `runCommands`. Computer names, local paths, worker versions, and protocol-capability booleans are intentionally omitted because the model does not need them to select or operate on a workspace.

When no workers are active, `workspaces` is empty and `availability` is `"offline"`. The managed-relay `message` asks the agent to have the user open a terminal in the workspace they want to expose, run `glossa`, keep that terminal open, and retry only after the user confirms the workspace is running. A custom relay instead points the agent to the platform-specific worker command in the self-hosting guide and uses the same confirmation boundary. When one or more workers are active, `availability` is `"online"` and `message` tells the agent to choose a workspace whose permissions match the requested operation. The offline result is a successful, user-safe response rather than a tool error. One enrolled computer may expose several independently routed workspaces; the public MCP contract names those routes as workspaces while internal device enrollment remains a separate concept. Local absolute paths are never transmitted to or returned by the hosted relay.

`get_logout_instructions` requires no worker. It returns the Auth0 browser logout URL and instructions that the model must present to the user. It does not navigate the browser, revoke credentials, or claim the user completed logout.

`list_files` returns at most 200 regular files or directories in deterministic global relative-path order, so cursor pagination cannot skip nested or sibling entries. On POSIX, discovered names containing literal backslashes use a `./` native-path prefix so the returned value can be passed unchanged to other path-based tools. It reads directory streams incrementally, never holds more than the 20,000-entry scan ceiling, never follows symlinks or junctions, and skips entries or child directories that become missing or inaccessible plus common dependency and version-control directories during recursive traversal. `nextCursor` is a separate native ordering key; pass it back unchanged as `cursor` so reusable path encoding cannot change pagination order. Callers should narrow `path` when the scan ceiling is reached.

`search_text` performs bounded literal or JavaScript regular-expression line matching without invoking a shell. Literal matching remains the default, and case sensitivity is configurable. Optional suffix filters support values such as `.ts` and `.d.ts`, while `includeGlobs` and `excludeGlobs` filter root-relative forward-slash paths before file contents consume the scan byte budget. It returns at most 100 matching lines with bounded 400-character snippets and scans at most 5,000 UTF-8 files, 32 MiB, or 20,000 filesystem entries. Files over 1 MiB, invalid UTF-8 files, links, transiently missing files, permission-denied files, and common dependency or version-control subtrees are skipped. Invalid regular expressions and glob patterns return `invalid_search`. These controls are part of structured-read authority; callers should not need `system` access merely to express a path-filtered repository search.

`view_image` reads one existing regular PNG, JPEG, or WebP file by validated file signature and returns at most 4 MiB of compressed image bytes as native MCP image content. Its `structuredContent` contains only MIME type, byte length, and SHA-256; image bytes are not duplicated into structured or text JSON. Glossa does not decode, OCR, resize, or otherwise render the image locally. Image pixels and embedded metadata are opaque to the textual authentication-secret detector and may themselves contain Restricted Data; callers must not use the tool on sensitive images.

`read_file_range` returns at most 500 complete normalized lines and 64 KiB per call, together with the full-file SHA-256, total line count, and `nextLine` continuation metadata. The full file remains subject to the 1 MiB UTF-8 limit. Every structured repository job receives a worker-local deadline equal to at most half the hosted request window and never more than 8 seconds. After that deadline, the read lane remains occupied until the current filesystem operation settles, any late directory handle is closed, and the worker returns `scan_timeout`; this bounds stalled work instead of accumulating background I/O.

Tool annotations must describe actual behavior. `write_file`, `edit_file`, `delete_path`, and `run_command` are non-read-only and destructive-capable. `make_directory` and `move_path` are non-read-only but not destructive: they do not delete or overwrite existing data, and their normal effects are reversible. `cancel_command` is also non-read-only and destructive because it terminates a process tree, although it does not undo effects already caused. Discovery, logout instructions, file reads, command status, and retained command-output ranges are read-only.
Every tool advertises the `glossa:access` OAuth scheme and is visible to the model. OpenAI-compatible `tools/list` responses expose the scheme at the tool root as `securitySchemes` while retaining the same value in `_meta.securitySchemes` for compatibility with the current MCP TypeScript SDK. The SDK is pinned exactly because root-level promotion wraps its installed `tools/list` handler until the SDK provides a public root-level registration API. `run_command` declares `openWorldHint: true` because a command can use the worker account's inherited network access and affect external systems. All other tools declare `openWorldHint: false`.
Every tool description begins with when to use it, includes disallowed cases when materially relevant, and states important behavior the schema cannot express, including Restricted Data handling. The server instruction puts workspace selection, permission enforcement, untrusted-data handling, and the Restricted Data prohibition in its first 512 characters before secondary workflow guidance. Every public input and output field includes a description. Successful structured results provide the complete typed value in `structuredContent`. Results through 16 KiB also mirror the equivalent JSON in text content for compatibility; larger results use a short text notice instead of transmitting the same payload twice. `view_image` is the deliberate exception: metadata is structured, while the image bytes appear only in the native MCP image content block.

## Worker job union

```ts
type WorkerJob =
  | { type: "read_file"; requestId: string; path: string }
  | { type: "view_image"; requestId: string; path: string }
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
      includeGlobs?: string[];
      excludeGlobs?: string[];
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
      type: "make_directory";
      requestId: string;
      path: string;
      recursive?: boolean;
    }
  | {
      type: "delete_path";
      requestId: string;
      path: string;
      recursive?: boolean;
    }
  | {
      type: "move_path";
      requestId: string;
      source: string;
      destination: string;
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
  | {
      type: "read_command_output";
      requestId: string;
      commandId: string;
      stream: "stdout" | "stderr";
      offset?: number;
      maxBytes?: number;
    }
  | { type: "cancel_command"; requestId: string; commandId: string };
```

The public MCP `run_command` input makes the command choice explicit as `command: { argv: string[] } | { shellCommand: string }`, so clients cannot provide both forms or omit both in a schema-valid call. The relay maps that nested choice to the flat worker job shown above. Clients should use `command.argv` for native executables such as Git and Node.js because direct execution avoids shell startup and parsing. Use `command.shellCommand` when the operation requires shell syntax such as pipes, redirection, variable expansion, or multiple statements. On Windows, also use `command.shellCommand` for command shims and name the `.cmd` or `.bat` file explicitly, for example `npm.cmd test`, because direct process spawning does not resolve those scripts and PowerShell may otherwise select a blocked `.ps1` shim.

An active worker executes structured file jobs without a separate local confirmation round trip when the selected startup profile permits them. `read-only` accepts structured reads only. `workspace` accepts structured reads plus `write_file`, `edit_file`, `make_directory`, `delete_path`, and `move_path` inside the root. `system` accepts those operations plus the command lifecycle and retained command-output reads, but every new `run_command` has an additional worker-local approval gate before process creation. Session startup authorizes the selected profile; it does not pre-authorize individual system command starts. Both the relay and worker return `write_access_disabled` or `command_access_disabled` before performing an operation forbidden by the profile, and the worker returns `command_not_approved` when a system command lacks or fails local approval. Structured file tools remain confined to the exposed root. Approved system commands retain the full operating-system authority of the local worker account.

The relay rejects recognizable authentication-secret material in structured mutation paths, `write_file`, `edit_file`, and `run_command` inputs before it creates a worker job. The worker independently repeats those checks and scans textual file and command results. A match returns `restricted_data_blocked` with a fixed message and never returns the matched value. `view_image` validates path, size, and media signature but does not OCR or otherwise inspect pixels or embedded metadata for Restricted Data. Explicit placeholders remain allowed. This is a high-confidence textual egress guard rather than a complete data-loss-prevention guarantee.

`write_file` encodes create-vs-replace intent through `expectedSha256`. Omitting it is create-only and returns `path_exists` if the target already exists. Providing the SHA from `read_file` or `read_file_range` is replace-only: the target must still exist at that exact revision or the write fails. The worker serializes writes, writes replacement data through a temporary file, and uses an exclusive filesystem link for creation so a concurrent external creator cannot turn a create into a silent overwrite.

`make_directory` creates one relative directory and optionally its missing parents. `delete_path` removes a regular file or directory; non-empty directories require `recursive: true`, and the exposed root can never be deleted. `move_path` renames or relocates a regular file or directory inside the root, refuses existing destinations, and prevents moving a directory inside itself. All three operations reject symlinks and junctions, are serialized with other structured mutations, and remain available in the default `workspace` profile without command authority.

`edit_file` applies one or more exact old-text/new-text replacements against the same original file. Every old-text value must be non-empty and occur exactly once, replacements may not overlap, and the worker always guards the final atomic write with the hash of the file it read. Before mutation, the worker scans the current file for recognizable authentication-secret material and uses the scanned SHA-256 as the write guard when the caller did not supply one. The optional caller-provided SHA-256 adds an earlier stale-revision check. A successful result returns the new hash, replacement count, and a bounded unified diff of the affected lines.

Only a `system` worker may receive a command-start job, and the local interactive terminal must approve that exact request before the worker creates a process. If no approval handler exists, the user denies the request, or the local session disconnects while approval is pending, the start fails closed. An approved process inherits the complete environment, credentials, filesystem permissions, and network access of the Glossa worker process. Local approval is not a sandbox or code-integrity guarantee: an earlier permitted workspace mutation can change a script or executable that a later approved command invokes. Glossa does not enumerate the environment automatically, and the MCP instructions tell the model not to inspect credentials or environment data. Recognizable authentication-secret inputs are rejected, and recognizable credential material in stdout or stderr is suppressed locally. Unknown or transformed values and direct network transmission remain possible under `system`.

`run_command` waits up to 750 milliseconds by default for fast completion, configurable from 0 through 5,000 milliseconds. Clients should pass `waitMs: 0` for commands expected to run longer than a few seconds so the running handle returns immediately. For short checks expected to finish near one second, `waitMs: 1500` to `2000` can avoid a second hosted tool round trip. A command that finishes within that budget returns its terminal status and bounded output in the same tool call; a longer command returns the public `workspaceId`, a running `commandId`, captured output so far, and a monotonic `sequence` when the worker supports incremental progress. `get_command`, `read_command_output`, and `cancel_command` use that explicit `workspaceId` together with `commandId`, so command control and retained diagnostics remain directly routable across relay restarts without a relay-side command-ID routing cache. `get_command` accepts waits up to 15 seconds. The relay may shorten the worker-side wait to reserve five seconds for queueing, delivery, result processing, and the hosted HTTP response within its configured request deadline. Passing the latest `sequence` as `afterSequence` makes that wait end when new output arrives or lifecycle state changes; omitting it preserves completion-oriented waiting. Results report `running`, `succeeded`, `failed`, `canceled`, or `timed_out` and include bounded output captured so far.

When `stdoutTruncated` or `stderrTruncated` is true, `read_command_output` retrieves another bounded retained window without rerunning the command. The caller selects one stream, a zero-based retained byte offset, and up to 64 KiB of source bytes; the default window is 32 KiB. Results include `nextOffset`, current command status, retained and total byte counts, a completion flag, and `retentionTruncated`. The worker retains at most 1 MiB independently for stdout and stderr. Bytes beyond that cap are not recoverable. A terminal command record is retained for at most five minutes, no more than eight recent records are kept, and all retained output disappears when its record is deleted.

The worker scans stdout and stderr incrementally while retaining bounded overlap across chunks. On a recognizable authentication-secret match it clears both captured streams, requests process-tree termination, wakes status waiters, and makes start, status, retained-output reads, or cancellation return only `restricted_data_blocked`. Termination does not undo effects that occurred before detection, and the scanner cannot prevent direct network exfiltration. Public MCP results omit worker-local lifecycle timestamps because clients do not need them to manage a command. `cancel_command` terminates the process tree. Disconnecting the worker rejects new jobs and terminates an active command. Command state, worker IDs, sequences, scan tails, default snapshots, and retained output ranges remain transient and are never persisted by the relay.

Full text-file reads and writes are limited to 1 MiB. `view_image` is limited to 4 MiB of compressed PNG, JPEG, or WebP bytes. Structured listings, searches, and ranged reads have the smaller per-call and scan ceilings described above. Returned standard output and standard error share a 12 KiB command-result budget. Each local stream retains a bounded beginning and rolling tail, then the worker allocates the response budget across both streams so noisy standard output cannot erase all diagnostic standard error. A truncated stream therefore preserves useful context from both ends and sets its truncation flag; clients should use `read_command_output` to inspect retained omitted bytes without rerunning the command. One command may run at a time per worker; another `run_command` request returns `command_busy` until the active command finishes or is canceled.

The requested command timeout defaults to 900,000 milliseconds and must be between 1 millisecond and the 3,600,000 millisecond hard maximum.

These are ordinary MCP tools so clients do not need native MCP Tasks support. Native task negotiation may be added after target client support is dependable, but it is not part of the public `3.1.0` contract.

## Error principles

- Return stable machine-readable codes.
- Do not include local absolute paths in hosted errors.
- Distinguish offline, timeout, stale revision, absent or ambiguous edit targets, overlapping edits, output truncation, command spawn failure, disabled writes, disabled commands, locally unapproved commands, and `restricted_data_blocked`.
- Permission errors are actionable and non-retryable: they tell the model to ask for a broader worker profile only when the user's requested task genuinely requires it; `command_not_approved` is also non-retryable and must not be reframed or bypassed.
- Authentication errors disclose no device or account existence.
