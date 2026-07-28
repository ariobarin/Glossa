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

## Device-authenticated worker API

Use:

```text
Authorization: Device gld_<device-id>_<secret>
```

### `POST /device/register`

Registers an active worker generation using an ephemeral worker UUID created by the CLI process. One enrolled device may register any number of workers. Reconnecting one worker replaces only that worker's generation. The request does not include the canonical local root or a derived repository name.

During a relay-first beta rollout, a current relay accepts both the worker-aware request shapes and the earlier single-worker shapes. A current CLI can also fall back to the earlier shapes when it reaches an older relay. That compatibility mode supports one active workspace per enrolled device and reports worker counts as unavailable until the relay is updated.

### `POST /device/poll`

Includes the worker ID and generation. Waits no more than 18 seconds. Returns one job or `204 No Content`. A worker has at most one delivered active job. Worker HTTP requests use a 19 second client timeout and reconnect with bounded exponential jitter.

### `POST /device/result`

Posts the worker ID and structured result for the delivered job. Late results after caller timeout are ignored.

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
- `write_file`
- `edit_file`
- `run_command`
- `get_command`
- `cancel_command`

`list_devices` returns an object with `devices`, `availability`, and `message`. It returns one device entry for every active worker. Its `deviceId` is the ephemeral worker identifier accepted by file and command tools, and `name` is the enrolled computer name. Each entry reports `path: "."`. When no workers are active, `devices` is empty, `availability` is `"offline"`, and `message` tells the agent that Glossa is the local bridge between ChatGPT and one explicitly exposed workspace, asks it to have the user start or reconnect the local Glossa worker, wait until it appears, and retry, and links to deployment-appropriate official documentation. The managed relay links to `https://glossa.sh/docs/quickstart`; a custom relay links to `https://github.com/ariobarin/glossa/blob/main/docs/self-hosting.md`. When one or more workers are active, `availability` is `"online"` and `message` confirms that workspaces are available. The offline result is a successful, user-safe response rather than a tool error. This preserves the existing MCP input name while allowing several independently routed workspaces on one enrolled computer. Local absolute paths are never transmitted to or returned by the hosted relay.

`logout` requires no worker. It returns the Auth0 browser logout URL and instructions that the model must present to the user. It does not navigate the browser, revoke credentials, or claim the user completed logout.

Tool annotations must describe actual behavior. `write_file`, `edit_file`, and `run_command` are non-read-only and destructive-capable.
Every tool advertises the `glossa:access` OAuth scheme in descriptor metadata and is visible to the model. `run_command` declares `openWorldHint: true` because a command can use the worker account's inherited network access and affect external systems. All other tools declare `openWorldHint: false`.
Tool descriptions state when the model should select each operation. Every public input and output field includes a description, and successful results provide both structured content and an equivalent JSON text fallback.

## Worker job union

```ts
type WorkerJob =
  | { type: "read_file"; requestId: string; path: string }
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
      waitMs?: number;
    }
  | { type: "cancel_command"; requestId: string; commandId: string };
```

`argv` and `shellCommand` are mutually exclusive.

An active worker executes valid `write_file`, `edit_file`, and bounded `run_command` jobs without a separate local confirmation round trip. Session startup is the local authorization boundary. File tools remain confined to the exposed root. Commands retain the full authority and permissions of the local worker account.

`edit_file` applies one or more exact old-text/new-text replacements against the same original file. Every old-text value must be non-empty and occur exactly once, replacements may not overlap, and the worker always guards the final atomic write with the hash of the file it read. The optional caller-provided SHA-256 adds an earlier stale-revision check. A successful result returns the new hash, replacement count, and a bounded unified diff of the affected lines.

Command processes inherit the complete environment of the Glossa worker process. Glossa does not enumerate or transmit that environment unless a user-authorized command explicitly reads or prints part of it.

`run_command` waits up to 750 milliseconds by default for fast completion, configurable from 0 through 5,000 milliseconds. A command that finishes within that budget returns its terminal status and bounded output in the same tool call; a longer command returns the worker `deviceId` and a running `commandId`. `get_command` and `cancel_command` require both values, so the relay routes command control directly instead of retaining a command-to-worker lookup. `get_command` may wait up to 15 seconds, then reports `running`, `succeeded`, `failed`, `canceled`, or `timed_out`, and includes bounded output after completion. Public MCP results omit worker-local lifecycle timestamps because clients do not need them to manage a command. `cancel_command` terminates the process tree. Disconnecting the worker rejects new jobs and terminates an active command. Command state, worker IDs, and output remain transient and are never persisted by the relay.

Text file content is limited to 1 MiB. Standard output and standard error share a 12 KiB command capture budget. Output beyond that budget is marked as truncated so the client can use a narrower follow-up command without exceeding its tool-result allowance. One command may run at a time per worker; another `run_command` request returns `command_busy` until the active command finishes or is canceled.

The requested command timeout defaults to 900,000 milliseconds and must be between 1 millisecond and the 3,600,000 millisecond hard maximum.

These are ordinary MCP tools so clients do not need native MCP Tasks support. Native task negotiation may be added after target client support is dependable, but it is not part of the core MVP contract.

## Error principles

- Return stable machine-readable codes.
- Do not include local absolute paths in hosted errors.
- Distinguish offline, timeout, stale revision, absent or ambiguous edit targets, overlapping edits, output truncated, and command spawn failure.
- Authentication errors disclose no device/account existence.
