# Core security and threat model

How Glossa protects local workspaces, accounts, credentials, and data.

## Warning

Glossa executes commands with the permissions and environment of the local account that launched it. File-tool root checks do not sandbox shell commands. A command may access credentials, developer tools, networks, or other files available to that account.

## Trust assumptions

- The Glossa operator controls the hosted relay and identity provider.
- The authenticated user intends to authorize the connected MCP client.
- The local computer and operating-system account are trusted.
- There is no hostile multi-tenant execution on one worker.
- TLS termination and OAuth token validation are correctly configured.

## Primary assets

- Local source code.
- Local developer credentials and environment.
- Device credentials.
- OAuth refresh/access tokens.
- Account/device ownership relationships.
- Command results and file contents in transit.

## Primary threats and controls

### Cross-account routing

**Threat:** an authenticated account guesses another device or job ID.

**Controls:**

- include `account_id` in all primary and foreign-key relationships;
- accept only the configured Auth0 subject prefix;
- require account ID in every query;
- never fetch by resource ID and check ownership afterward when an account-scoped query is possible;
- use opaque random identifiers;
- bind local device credentials to the authenticated subject before reuse;
- verify account isolation with direct integration checks before deployment.

### Stolen device token

**Threat:** token grants remote execution on an exposed root.

**Controls:**

- 256-bit random secret;
- transmit only over HTTPS;
- store only salted scrypt hash;
- display or return once;
- operating-system credential storage, with an explicit warning before a local file fallback;
- device-specific revocation;
- failed-authentication rate limiting and constant-time comparison;
- never log Authorization headers.

### Malicious or compromised MCP client

**Threat:** authenticated client requests destructive actions.

**Controls:**

- explicit OAuth authorization;
- accurate MCP tool annotations;
- narrow exposed root;
- temporary exposure by default;
- treat local session startup as authorization for writes and bounded commands without per-operation confirmation;
- display the full shell-authority warning before connection;
- show write and command activity locally;
- visible local status and immediate disconnect;
- no implicit broad-root exposure.

### Path escape

**Threat:** absolute paths, parent traversal, symlinks, junctions, or writable ancestors escape the root.

**Controls:**

- enforce canonicalization, realpath, symlink, and junction checks for the host operating system;
- validate existing paths and nearest writable ancestors locally;
- reject absolute paths and lexical parent escapes;
- revalidate root-relative paths for every operation;
- preserve correct case-sensitive or case-insensitive path comparison for the host;
- verify Windows junction and reparse-point behavior and POSIX symlink behavior when path enforcement changes.

### Shell authority

**Threat:** a command accesses resources outside the exposed file root.

**Reality:** this is expected shell authority, not a bug in path tools. Command filtering is not a sandbox.

**Controls:**

- state the risk honestly;
- require explicit session startup, but do not prompt locally for each command;
- inherit the complete worker process environment, including available developer credentials;
- never enumerate, persist, or log environment variables automatically;
- run under a dedicated OS account for unattended use;
- recommend a container or VM when stronger isolation is required;
- bound duration and output;
- terminate process groups and discovered descendants.

### Logging leakage

**Threat:** source code, command output, paths, or tokens reach platform logs.

**Controls:**

- structured metadata logs only;
- redact headers and bodies;
- never attach request or response content;
- never add local absolute paths or derived repository names to relay metadata or logs;
- verify log scrubbing before deployment.

### Relay compromise

**Threat:** attacker controls the routing service.

**Controls and limits:**

- relay does not possess local repository clones or developer credentials;
- device tokens are sufficient to issue jobs while a worker is exposed, so relay compromise remains serious;
- minimize dependencies and privileges;
- use managed platform patching, secret scanning, exact dependencies, and rapid device revocation.

## Data retention

Durably retain only what is needed for account/device operation and security:

- device ID, name, platform, created, last seen, and revoked timestamps;
- OAuth subject identifier;
- metadata-only audit event type, status, and timestamp.

Do not durably retain:

- file content;
- command input or output;
- environment variables;
- full local paths;
- repository names unless explicitly chosen by the user;
- OAuth or device bearer secrets.

Additional defenses must extend these controls rather than replace them.
