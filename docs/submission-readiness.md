# Plugin submission readiness

**NO-GO for final public submission** until every gate below has evidence for the version being submitted. A passing automated check is not a policy determination or proof of reviewer access. Use a draft for integration testing in the meantime.

The [submission packet](app-submission-packet.md) contains listing copy, tool annotations, reviewer setup, test cases, and the current OpenAI requirement links. Submit the remote server directly using **With MCP**. A generated integration-ID package is not required.

## Automated checks

Run from the reviewed source checkout:

```powershell
npm run review:check:submission
```

This checks documentation, listing fields, MCP contracts, the build and tests, public production endpoints, published CLI versions and native assets, dependency vulnerabilities, npm package contents, and whitespace. It does not inspect the authenticated submission portal, prove deployment provenance, exercise a reviewer login, or verify host confirmation behavior.

Reset the deterministic fixture before reviewer testing. Run the worker only in the isolated reviewer environment described below, not under an operator's personal account:

```powershell
npm run review:fixture:prepare
glossa --access system --label openai-review .review-workspace
```

## Source and deployment

- [ ] Review and merge the required changes, then deploy the approved relay revision. Record the relay commit, published CLI version/tag and source revision, and test date. Release changed CLI behavior before claiming it in the listing.
- [ ] `npm run review:check:submission` passes against that source and production deployment. Resolve relevant open security fixes before the final scan.
- [ ] Accept `https://mcp.glossa.sh` as the long-lived MCP origin; changing scheme, host, or port after publication requires a new plugin submission.
- [ ] A fresh **Scan Tools** reports contract `3.1.0` and exactly 16 tools. Compare every description, input/output schema, OAuth security scheme, compatibility `_meta`, annotation, and server instruction with the submission packet. Do not reuse a scan from before deployment.

## Reviewer access

- [ ] A dedicated Auth0 database reviewer account is pre-verified and admitted by exact subject, not a provider-wide `auth0|` allowlist. Its username/password are stored only in protected operator/portal fields, never this repository.
- [ ] Reviewer login works without MFA, SMS, email access, passwordless links, CAPTCHA, private networking, or operator approval in both client OAuth and CLI pairing.
- [ ] Only the reset `openai-review` fixture is exposed to that account. The worker runs under an isolated operating-system account, container, or VM without personal sessions, cloud credentials, SSH agents, private repositories, customer data, or production access.
- [ ] From an unrelated network, complete OAuth, discover the worker, and run the portal cases without intervention. Assign an owner to keep the account and worker available throughout review.

## Portal and listing

- [ ] The intended publisher identity is verified, the submitter has Apps Management write permission, and the project uses global data residency rather than EU data residency.
- [ ] Choose **With MCP**, Universal URL `https://mcp.glossa.sh/mcp`, OAuth scope `glossa:access`, and no skills or custom UI. Verify authorization-code flow, PKCE S256, protected-resource metadata, `resource` handling, supported client registration, and current redirect URIs. For enterprise domain restrictions, verify the actual OIDC UserInfo response supplies the account's verified email, not merely advertised claims.
- [ ] Set the portal's exact domain token only as `GLOSSA_OPENAI_APPS_CHALLENGE`; verify it is served at `/.well-known/openai-apps-challenge` and accepted by the portal. Do not replace another plugin's verification token.
- [ ] Enter the packet's listing copy, verified developer name, four public HTTPS URLs, Developer Tools category, capabilities, intentionally selected countries/localization, attestations, and release notes. Confirm the portal's current field limits and accurate product claims.
- [ ] Exactly five positive and exactly three negative test cases from the packet are entered with reproducible expected results and reviewer instructions.
- [ ] Both branding fields, `interface.logo` and `interface.composerIcon`, use valid square PNG/JPEG/WebP/SVG assets, 48 to 4096 pixels and at most 5 MiB each. Reuse `site/glossa-symbol-badge.svg`. Omit screenshots because Glossa has no custom UI.
- [ ] The required demo recording URL is accessible without requesting access and shows the reviewed production connection on supported ChatGPT and Codex surfaces. Follow [the recording script](demo-recording.md); never include secrets or unrelated desktop content.

## ChatGPT and Codex behavior gates

- [ ] Replay the packet's portal cases, broader positive/negative cases, permission tests, and `review/metadata-golden.json` against the final tool scan. Record selected tools, material arguments, confirmation/block behavior, and outcomes on supported ChatGPT and Codex surfaces. Negative prompts must not trigger unrelated Glossa calls.
- [ ] Exercise every tool through MCP Inspector with representative inputs, missing identifiers, edge cases, and empty results. Inspect representative API Playground request/response flows for schema, auth, and unexpected-data errors.
- [ ] Observe a harmless `node --version` command and a destructive `Delete notes/review.txt using a command` request. Do not approve the destructive action during the safety check. Record actual host permission settings; do not infer confirmation behavior from annotations alone.
- [ ] Credential requests do not invoke Glossa; `notes/untrusted-instructions.txt` remains untrusted data; a `workspace` worker denies commands without bypass; and `view_image` returns native image content without duplicating bytes in `structuredContent`.

## Policy gate

- [ ] The Restricted Data decision in [the policy review](restricted-data.md) is explicitly resolved and its evidence recorded.

Acceptable outcomes are an explicit OpenAI determination that the documented architecture complies, an enforceable public data-source/workspace restriction that excludes prohibited categories, or credential-free managed execution with the public file and image boundary separately resolved. Removing `system` alone is insufficient. Metadata, a user checkbox, host confirmation, a source-extension allowlist, and the recognizable-secret detector do not establish compliance.

## GO rule

**GO** only when every gate above has evidence for the reviewed deployment. Otherwise keep the submission in draft. Approval and subsequent publication are separate actions; do not describe an unapproved plugin as official or endorsed.
