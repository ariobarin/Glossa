# Core security and threat model

How Glossa protects local workspaces, accounts, credentials, and data.

## Security boundary

Each worker exposes one canonical local directory and one access profile:

| Profile | Structured reads | Guarded mutations inside root | Commands |
| --- | --- | --- | --- |
| `read-only` | Yes | No | No |
| `workspace` (default) | Yes | Yes | No |
| `system` | Yes | Yes | Yes |

The selected profile is visible in the local terminal and returned by `list_workspaces` as both a profile and exact permission booleans. The relay rejects an operation outside that profile before queueing it. The local worker independently performs the same check before reading, writing, or starting a process. This defense in depth protects against relay mistakes, stale clients, protocol skew, and attempted bypasses through direct worker traffic.

## Warning about system access

`system` access is explicit remote command authority for the operating-system account that launched Glossa. A command inherits that process's complete environment, credentials, filesystem permissions, and network access. It starts in the exposed root but is not confined there. File-tool containment does not sandbox commands, and command filtering is not presented as a security boundary.

Use the default `workspace` profile when file changes, directory creation, deletion, or moves inside the exposed root are sufficient. Enable `system` only when the requested task genuinely requires the local toolchain. Use a dedicated operating-system account, container, or virtual machine when stronger isolation is required.

## Trust assumptions

- The Glossa operator controls the hosted relay and identity provider.
- The authenticated user intends to authorize the connected MCP client.
- The local computer and selected operating-system account are trusted for the chosen profile.
- There is no hostile multi-tenant execution inside one local worker process.
- TLS termination, OAuth token validation, and deployment secrets are correctly configured.
- The user understands that `system` is broader than the exposed file root.

## Primary assets

- Local source code and project data.
- Local developer credentials, environment, tools, and network identity.
- Device credentials and ephemeral worker credentials.
- OAuth refresh and access tokens.
- Account, device, worker, and job ownership relationships.
- Command details, command results, and file contents in transit.

## Primary threats and controls

### Cross-account routing

**Threat:** an authenticated account guesses another account's device, worker, command, or job identifier.

**Controls:**

- include `account_id` in all primary and foreign-key relationships;
- validate JWT signature, issuer, audience, expiry, required scope, and explicit Auth0 provider-prefix and exact-subject allowlists;
- require account ID in every database and in-memory ownership lookup;
- never fetch by resource ID and check ownership afterward when an account-scoped query is possible;
- use opaque random identifiers;
- require a single-use, short-lived pairing code claimed through an authenticated control-panel session before enrolling each new computer;
- bind ephemeral worker credentials to one account, device, worker ID, and generation;
- verify account isolation with direct integration checks before deployment.

### Pairing authorization interception

**Threat:** an attacker tricks a user into redeeming a pairing code for an unintended computer or captures a pairing code before the legitimate user redeems it.

**Controls:**

- issue single-use pairing codes with a ten-minute TTL;
- store only a SHA-256 hash of each code in the relay database;
- rate-limit pairing-code creation and redemption;
- require the human's authenticated control-panel session, validated for issuer, audience, provider allowlist, and the device-enrollment scope, to claim a code;
- show the requesting device name and platform on the panel before the user confirms;
- store only the issued revocable device credential on the paired computer.

Before confirming, verify that the device name on the panel matches the computer being paired and that the panel is signed in to the intended account. Revoke an unfamiliar device immediately from the devices view of any paired computer (press `d`).

### Stolen device token

**Threat:** a device token is used to operate workers for the affected account, or to list and revoke that account's devices.

**Controls:**

- generate a 256-bit random secret;
- transmit it only over HTTPS;
- store only a salted scrypt hash in the relay database;
- display or return the raw secret once;
- store it locally in the operating-system credential store, with an explicit warning before a restricted file fallback;
- support device-specific revocation, including self-revocation through `glossa unpair`;
- apply failed-authentication rate limiting and constant-time comparison;
- never log Authorization headers.

Device management authority is scoped to the token's own account, and enrolling a new device always requires a human to redeem its pairing code in an authenticated panel session: a device token cannot create another device. Revocation is visible in audit events and recoverable by re-pairing. A device token does not silently broaden a worker's selected access profile. The relay and worker still enforce that profile for every operation.

### Stolen worker token

**Threat:** an active worker credential is replayed against relay worker endpoints.

**Controls:**

- create an independent 256-bit random secret for each worker generation;
- bind it to one account, device, worker ID, and generation;
- store only its SHA-256 digest in relay process memory;
- invalidate it on reconnect, unregister, device revocation, or liveness expiry;
- reject mismatched worker IDs and generations;
- transmit it only over HTTPS and never log Authorization headers;
- keep the access profile in relay-side worker state and enforce it before queueing work.

### Malicious or compromised MCP client

**Threat:** an authenticated client requests destructive, overbroad, secret-seeking, or unrelated actions.

**Controls:**

- require explicit OAuth authorization and the `glossa:access` scope;
- publish accurate MCP tool schemas, output contracts, side-effect annotations, and use/disallow descriptions;
- tell the model not to use Glossa for general questions, web research, built-in ChatGPT tasks, credential inspection, or work unrelated to the local workspace;
- expose only one narrow root per worker and reject implicit home or filesystem-root exposure;
- let the user select `read-only`, `workspace`, or explicit `system` authority at startup;
- enforce the selected authority in both the relay and local worker;
- treat startup as authorization only for operations inside the selected profile, without claiming per-command local confirmation;
- show the selected profile and compact write or command activity locally;
- provide visible status, immediate disconnect, logout, and device revocation;
- treat all file and command output as untrusted data rather than instructions;
- reject recognizable authentication secrets in mutation and command inputs before relay dispatch, and suppress recognizable credential material before file or command results leave the worker.

### Permission downgrade or metadata mismatch

**Threat:** the relay, model, documentation, or local worker disagrees about the authority of an online workspace.

**Controls:**

- use one protocol enum and one permission-mapping function across the CLI and relay;
- include the profile in current worker registration and echo it in the registration response;
- expose the profile and derived booleans through `list_workspaces`;
- reject writes and commands before relay dispatch when permission is absent;
- reject the same operations again inside `LocalWorker`;
- return stable, actionable `write_access_disabled` and `command_access_disabled` errors that tell the model not to retry or bypass the boundary;
- cover all profiles at the CLI, relay, MCP, and local-worker test layers.

### Path escape

**Threat:** absolute paths, parent traversal, symlinks, junctions, case aliases, or writable ancestors escape the structured file root.

**Controls:**

- enforce canonicalization, realpath, symlink, junction, and reparse-point checks for the host operating system;
- validate existing paths and nearest writable ancestors locally;
- reject absolute paths and lexical parent escapes;
- revalidate root-relative paths for every structured file operation, including directory creation, deletion, and moves;
- reject deleting or moving the exposed root, reject existing move destinations and self-nesting directory moves, and require an explicit recursive flag before deleting non-empty directories;
- stream directory entries into bounded traversal state, skip links and unavailable files during listing and search, and cap entries, files, bytes, matches, lines, returned content, and elapsed local scan time;
- preserve discovered native filenames; prefix POSIX names containing literal backslashes with `./` so they remain safely reusable, and normalize returned separators only on Windows;
- preserve correct case-sensitive or case-insensitive comparison for the host;
- verify Windows junction and reparse-point behavior and POSIX symlink behavior whenever path enforcement changes.

### System-command authority

**Threat:** a system-profile command reads secrets, modifies resources outside the root, reaches the network, or affects an external service.

**Reality:** these are possible consequences of the explicitly selected `system` profile, not capabilities of structured file tools. Glossa preserves arbitrary project command execution because using the existing local toolchain is a core function, but it does not describe that authority as sandboxed.

**Controls and limits:**

- make `workspace`, not `system`, the default;
- require the user to start `glossa --access system` explicitly;
- disclose inherited environment, credentials, filesystem permissions, and network access in CLI help, HUD, quickstart, terms, security pages, MCP instructions, tool descriptions, and reviewer material;
- tell the model not to use commands for general web research, credential or environment inspection, or bypassing structured file-tool boundaries;
- reject recognizable authentication-secret inputs at the relay and worker;
- scan textual file results, edit diffs, command-output chunks, and every retained output range locally; retain bounded overlap across chunks, clear captured and retained output, terminate the process tree, and return only `restricted_data_blocked` when a match is detected;
- never enumerate, persist, or log environment variables automatically;
- keep default command snapshots bounded; cap each retained range at 64 KiB, each retained stream at 1 MiB, terminal records at five minutes, and recent command records at eight; also bound command duration, concurrency, and status waits;
- terminate the process tree on cancellation, timeout, worker shutdown, or disconnect;
- make cancellation disclosure accurate: stopping a process does not undo prior local or external effects;
- recommend a dedicated OS account, container, or VM for unattended or sensitive use.

The authentication-secret detector is deliberately high-confidence. It does not recognize every custom, encoded, encrypted, compressed, fragmented, or transformed value, and it cannot prevent a command from sending data directly to the network. Detection can occur only after earlier command effects. The detector is defense in depth, not a sandbox, complete data-loss-prevention system, or substitute for a credential-free runtime. Public submission remains gated by the decision in [Restricted authentication data review](restricted-data.md).

### Restricted Data in tool traffic

**Threat:** a tool input, file result, edit diff, or command stream contains payment-card data subject to PCI DSS, protected health information, a government identifier, an API key, password, MFA or OTP code, access token, private key, or other authentication secret.

**Architectural limit:** the implemented detector addresses recognizable authentication secrets only. It does not attempt to classify arbitrary text as PCI data, PHI, or a government identifier. A user-selected file may contain those categories before any general local-file bridge can know what it contains. The public submission gate in [Restricted Data review](restricted-data.md) therefore applies to all access profiles.

**Controls:**

- reject recognizable secret-bearing structured mutation paths plus `write_file`, `edit_file`, and `run_command` inputs in the relay before queueing a worker job;
- repeat input checks locally so older or compromised relay behavior cannot bypass the worker boundary;
- preflight an edited file before mutation and bind the edit to the scanned SHA-256 when the caller did not already provide one;
- inspect textual content-bearing file results, command snapshots, and every retained command-output range before they leave the worker;
- treat `view_image` as an explicit opaque-media exception: validate the root-confined regular-file path, a 4 MiB compressed-byte ceiling, and PNG/JPEG/WebP signatures locally, but do not claim to inspect pixels or embedded metadata for Restricted Data;
- inspect command output incrementally with overlap across chunks so a token split across writes is still detected;
- clear captured and retained output, stop the command process tree, and return a fixed safe error without the matched value;
- redact restricted command inputs from local activity events;
- permit explicit placeholders such as `<redacted>` and `replace-me` so documentation and fixtures remain usable;
- test the detector against the repository corpus to prevent ordinary source code from becoming unreadable.

**Limits:** the worker necessarily handles local bytes while deciding whether to block them, unknown formats can evade recognition, and a command can transmit data without printing it. Images returned by `view_image` are not OCR-scanned or metadata-scrubbed; visible text and embedded image metadata can therefore leave the worker without passing through the textual authentication-secret detector. The only dependable boundary against those cases is an isolated credential-free account or runtime with enforceable filesystem, agent, metadata-service, and network restrictions.

### Logging leakage

**Threat:** source code, command details, output, paths, tokens, or identities reach platform logs or durable audit storage.

**Controls:**

- record structured operational metadata only;
- redact headers and bodies;
- never attach request or response content to logs;
- never add local absolute paths or path-derived repository names to relay metadata or logs;
- retain an optional workspace label only when the user supplies it explicitly and only for the active worker lifetime;
- omit file contents, command arguments, output, environment variables, and bearer tokens from durable audit events;
- verify log scrubbing before deployment.

### Relay compromise

**Threat:** an attacker controls the routing service or its process memory.

**Controls and limits:**

- the relay does not possess local repository clones or durable developer credentials;
- device or worker credentials can issue jobs while an authorized worker is exposed, so relay compromise remains serious;
- relay-side profile enforcement reduces accidental overreach, while local enforcement remains authoritative against a forbidden operation;
- minimize dependencies and privileges;
- use managed platform patching, exact dependencies, secret scanning, short-lived worker credentials, and rapid device revocation;
- keep production content out of logs and durable routing state.

A fully malicious relay can still send any protocol job to a connected worker. The local profile boundary prevents a read-only or workspace worker from executing a command, but a `system` worker intentionally retains broad command authority. Stronger protection requires running that worker inside an isolated OS account, container, or VM.

## Data retention

Durably retain only what is needed for account, device, and security operation:

- device ID, user-supplied name, platform, created, last-seen, and revoked timestamps;
- OAuth subject identifier;
- metadata-only audit event type, status, and timestamp;
- optional request timing events limited to a bounded operation label, HTTP status, and duration, with no identifiers, paths, arguments, output, tokens, or request bodies.

Do not durably retain:

- file content;
- command input or output;
- environment variables;
- full local paths;
- repository names unless explicitly supplied as an ephemeral label;
- OAuth, device, or worker bearer secrets;
- reviewer passwords or other portal credentials.

Additional defenses must extend these controls rather than replace them.
