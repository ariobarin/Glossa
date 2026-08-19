# Relay-blind transport design

Status: **Proposed architecture. Not implemented.**

This document defines what Glossa would need before it can truthfully claim that the managed relay cannot read or forge workspace traffic. The current managed service does **not** provide that property: HTTPS encrypts each network hop, while the hosted MCP relay receives application-layer tool arguments and worker results in plaintext process memory so it can route them.

## Problem

The current path is:

```text
MCP client
    |
    | HTTPS + OAuth
    v
managed Glossa MCP relay
    |
    | HTTPS + worker credential
    v
local Glossa worker
```

The relay is therefore part of the trusted computing base. A relay compromise does not produce a durable repository clone or durable developer credential, but it can observe traffic while jobs are routed and can submit protocol jobs to connected workers. The worker's access profile, restricted-data checks, and local system-command approval remain authoritative local defenses, but they do not make the relay cryptographically blind.

Worker-side encryption alone cannot fix this. By the time a worker receives a job, the current hosted MCP server has already received and parsed the semantic tool request. Encrypting the next hop would protect only relay-to-worker transport, which HTTPS already protects. Likewise, a key stored by the relay cannot make the relay unable to decrypt or forge traffic.

## Security goal

A relay-blind design should treat the managed routing service as potentially malicious. Compromise of its process memory, database, deployment credentials, or routing logic must not let the attacker:

- decrypt workspace paths, file contents, edit text, command arguments, command input, or command output;
- create, alter, or substitute a valid workspace operation;
- replay a previously accepted operation outside the protocol's explicit replay window;
- impersonate either endpoint after a session key has been rotated or revoked.

The relay may still learn the metadata required to operate the service, such as account and device relationships, an opaque worker routing identifier, connection timing, message size, and liveness. Any operation class or access-profile metadata intentionally left visible must be documented as metadata leakage rather than described as encrypted content.

This goal does not sandbox `system` commands, protect a compromised MCP client or local worker, hide IP addresses or traffic timing, or change Restricted Data policy. Endpoint security and local isolation remain separate requirements.

## Hard client constraint

For the managed relay to be unable to read a request, encryption and request authentication must happen **before the managed relay receives the semantic MCP tool arguments**.

The current deployment does not have such an endpoint. The MCP client speaks directly to the hosted Glossa MCP server, so the server necessarily sees decoded tool names and arguments. A relay-only patch cannot turn that topology into end-to-end encryption.

A real implementation therefore requires one of these endpoint changes:

1. **Client-side encryption support.** The MCP client or a trusted companion encrypts and authenticates each operation for the selected worker before sending an opaque envelope through Glossa.
2. **A direct authenticated peer channel.** The managed service acts only as rendezvous while the client endpoint and worker establish a channel whose session keys never reach the relay.
3. **A user-owned endpoint.** A self-hosted relay changes who is trusted, which is useful, but it is not relay-blind encryption unless that relay also routes opaque endpoint-encrypted traffic.

Do not market self-hosting, another TLS layer, worker-side encryption, or relay-held keys as end-to-end encryption.

## Proposed endpoint protocol

When a supported client-side endpoint exists, use a standard, reviewed secure-channel construction rather than bespoke cryptography. The concrete library and wire construction require a separate implementation review, but the protocol must provide these properties.

### Endpoint identity and key agreement

- The local worker creates an ephemeral session key pair for each exposure generation.
- The client endpoint creates its own ephemeral session key pair.
- The user-authorized device/worker identity binds the worker's ephemeral key to the intended account and exposure generation.
- The client must authenticate the worker binding through data the managed relay cannot silently substitute. A relay-supplied unauthenticated public key is insufficient because a malicious relay could replace it and perform a man-in-the-middle attack.
- Session keys are derived only at the two endpoints and are never sent to or stored by the managed relay.
- Reconnect, profile replacement, device revocation, and explicit disconnect rotate or destroy the session binding.

The implementation should use an established protocol or audited library that supplies authenticated key agreement and AEAD rather than constructing a novel combination of primitives.

### Opaque request envelopes

Every encrypted request must bind at least:

- protocol version;
- endpoint/session identifier;
- direction;
- monotonically increasing sequence or equivalent anti-replay value;
- the complete semantic operation and arguments;
- any visible routing metadata that must not be malleable.

The worker rejects authentication failure, replay, stale session identifiers, invalid sequence state, and any operation outside its local access profile. The relay may route the envelope but cannot produce another valid envelope or change protected fields.

If operation class or profile remains visible so the relay can perform scheduling or coarse policy checks, that metadata must be cryptographically bound into the envelope and treated as public metadata. Local enforcement remains authoritative.

### Opaque response envelopes

Worker results use the same authenticated channel in the opposite direction. File contents, diffs, command output, errors derived from local data, and command details remain encrypted until the client endpoint decrypts them.

The relay may retain only the minimum transient opaque bytes needed to route an active request. Existing metadata-only logging rules continue to apply; ciphertext must not become a new durable job store by default.

## Interaction with current defenses

Relay-blind transport complements rather than replaces the existing local boundaries:

- `read-only`, `workspace`, and `system` continue to be enforced by the worker.
- Every new `system` command continues to require local terminal approval.
- Structured path confinement remains local.
- Restricted authentication-data checks that must inspect plaintext move to or remain at trusted endpoints. Relay preflight cannot inspect encrypted content.
- A credential-free operating-system account, container, or virtual machine remains the dependable containment boundary for sensitive `system` use.

A malicious relay could still drop, delay, duplicate, reorder, or deny opaque traffic. Availability against the relay is not an end-to-end confidentiality or integrity property.

## Acceptance tests for an E2EE claim

Glossa must not describe managed traffic as relay-blind or end-to-end encrypted until automated adversarial tests demonstrate all of the following:

1. Capturing relay process memory during a fixture read, edit, and command does not reveal fixture plaintext, relative paths, command arguments, or command output beyond intentionally documented metadata.
2. A relay database dump contains no endpoint session keys and cannot decrypt captured envelopes.
3. A malicious relay that changes any protected request or response byte causes endpoint authentication failure rather than a modified operation.
4. A malicious relay cannot substitute a worker public key without the client endpoint detecting the identity-binding failure.
5. Replaying a previously accepted request is rejected and cannot create a second side effect.
6. Reconnect and device revocation make old session material unusable.
7. Cross-account and cross-worker envelope substitution is rejected.
8. Log and tracing systems contain no plaintext workspace payloads or endpoint session keys.
9. The documented metadata-leakage list matches what a relay observer can actually see.
10. The design receives an independent cryptographic/security review before any public E2EE marketing claim.

Tests must run with a deliberately malicious relay shim, not only against a cooperative relay implementation.

## Rollout sequence

### Phase 0 — current hardening

Keep `workspace` as the default, require local approval for every new `system` command, keep credentials out of exposed workspaces, and recommend an isolated runtime for sensitive command use. Describe the managed relay as trusted application infrastructure, not as an opaque tunnel.

### Phase 1 — endpoint capability and identity binding

Define a versioned client capability for opaque Glossa envelopes and an authenticated way for the client endpoint to bind an ephemeral worker key to the user-authorized worker. Do not enable encryption until substitution by the relay is impossible.

### Phase 2 — encrypted request/response envelopes

Route authenticated ciphertext through the managed service. Move any plaintext-dependent enforcement that remains necessary to trusted endpoints and document metadata that stays visible for routing or scheduling.

### Phase 3 — adversarial verification and migration

Run malicious-relay tests, external review, key-rotation and downgrade tests, and mixed-version migration tests. Fail closed on attempts to downgrade a session that the user or client requires to be relay-blind.

Only after this phase should the product claim that the managed relay is cryptographically unable to read or forge workspace content.

## Decision

The current trusted-relay design remains supported until a client-side endpoint can participate in authenticated encryption. Glossa should improve containment and transparency now, but it should not ship relay-side "E2EE" that leaves the relay holding plaintext or decryption authority.
