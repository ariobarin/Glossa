# Local integration and resource tests

Use synthetic disposable workspaces and identities only. These commands need
Node 24 and built packages. They never need a real account or credential store.

```sh
npm ci
npm run check
npm run integration:local
```

`integration:local` requires Docker Compose 2.24.4 or newer for override tags.
It reuses the repository's Postgres service with tmpfs storage and an assigned
loopback port, under a per-process `glossa-integration-<pid>` project. It refuses
existing containers or volumes in that project. It supplies a synthetic Compose env file
instead of loading `.env`, and tears down only its own project. Relay and issuer
ports are selected from available loopback ports; a competing bind fails the
run. No public relay or database endpoint is accepted by the smoke.

The smoke exercises signed OAuth tokens over actual MCP HTTP, Postgres account
and device storage, the built relay, and the built headless CLI with an isolated
config and keyring replacement. It covers pairing, revocation, cross-account
reads and writes, scope denial, access profiles, traversal, stale SHA guards,
filesystem mutations, image content, hostile search deadlines, command capacity,
status waits, command timeout, cancellation, output truncation and disconnect cleanup.

Boundary fixtures include a 1,048,576-byte text file, a 1,048,577-byte rejected
file, and multibyte lines at 65,536 and 65,537 bytes. Range reads return 65,535
bytes from the large file and exactly 65,536 bytes from the long-line fixture.
Command fixtures emit 1,114,112 bytes on each stream, require a combined snapshot
at most 12,288 bytes, and verify 1,048,576 retained bytes per stream with
65,536-byte range retrieval.

## Opt-in worker soak

```sh
npm run test:soak
```

This is in-process `LocalWorker` and `CommandService` coverage, not HTTP, OAuth,
relay, Postgres or HUD memory coverage. It runs in a separate Node process with
a 96 MiB old-space limit and exposed GC. Warmup performs 1,000 actual file reads
and ten commands. Five repeat batches then perform 100,000 actual file reads,
half whole-file and half ranged, plus 50 commands. Every range operation reads
the actual 1 MiB source file. Each command emits the two oversized streams above.
Each ten-command cycle verifies terminal record eviction and output caps.

Every batch samples heap, RSS, external memory and ArrayBuffers after three GC
passes separated by event-loop turns. Bounds in MiB:

| Metric | Growth from warmup | Last three batches' spread | Absolute cap |
| --- | ---: | ---: | ---: |
| Heap | 8 | 4 | 64 |
| ArrayBuffers | 4 | 2 | 24 |
| External | 8 | 4 | none |
| RSS | 96 | 64 | 192 |

The same worker then remains idle for eleven 30-second intervals. It measures
memory at each interval, bounds idle heap/buffer/RSS growth, checks real
five-minute command expiry, and requires more than 12 MiB of output buffers to
be released. This checks retained state rather than merely process survival.
RSS may stay allocated after buffers are released; it has a separate budget.

For a shorter diagnostic, set `GLOSSA_SOAK_READS=100`. This still runs warmup,
five batches and the full 330-second idle expiry. Counts must be multiples of
ten. CI runs the soak only when the manual `resource-soak` input is selected.
Ordinary CI keeps `npm run check`, the real integration smoke, and the container
smoke. The container build checks the Linux production dependency/image boundary
and graceful shutdown; it is not a duplicate of the repository's CLI build.
The integration runner reuses the build from `check` and adds no second build.

Existing unit tests retain complementary coverage: tiny buffer chunks,
expired command-status subscriptions, read-deadline lane ownership and late
handle cleanup, timed-out relay jobs, stale workers and generations, restricted
data, and local permission enforcement. Do not remove those in favor of a soak.

Finite runs cannot prove OOM impossible. Longer idle runs, allocator behavior on
other platforms, packaged HUD retention, network churn and relay/Postgres memory
require separate evidence. Docker or process-tree termination failures must be
reported as blockers, not replaced with mocked integration success.
