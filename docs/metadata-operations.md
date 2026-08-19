# MCP metadata evaluation and operations

This runbook keeps Glossa's MCP discovery metadata measurable after the initial plugin submission. It complements the submission packet rather than replacing the portal's exact five-positive/three-negative review cases.

## Golden prompt corpus

`review/metadata-golden.json` is the versioned regression corpus for tool discovery and negative routing. It contains direct, indirect, follow-up, negative, and authority-boundary prompts. Keep prompts stable while evaluating one metadata change so differences remain attributable.

Run the structural check with:

```shell
npm run review:metadata:check
```

## Private ChatGPT iteration

Do not deploy metadata experiments to production just to inspect ChatGPT's UI or tool selection. Run the exact branch locally with `docker compose up -d --build --wait`, then use OpenAI's [Secure MCP Tunnel](https://github.com/openai/tunnel-client) to connect the private `http://127.0.0.1:39100/mcp` endpoint. Follow the current OpenAI tunnel setup rather than copying a pinned tunnel-client binary or maintaining a Glossa wrapper.

In [ChatGPT Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt), create a draft app backed by that tunnel and run **Scan Tools**. After changing tool metadata, rebuild/restart the local relay and use **Refresh** before opening a fresh test chat. The tunnel forwards OAuth-protected MCP traffic and rewrites protected-resource discovery URLs; the configured authorization server itself must remain publicly reachable.

Put the dedicated development Auth0 relay and optional panel settings in `.env`; Compose forwards that file to the local relay without baking it into the image. The local `dev:auth` issuer remains for automated integration tests, not browser-facing ChatGPT OAuth. Do not reuse production identity configuration.

For calls that require a live worker, keep its device credential isolated from the normal production-paired CLI. The current CLI stores one relay-bound device pairing per operating-system user, so switching that same credential to a development relay intentionally revokes and replaces the old pairing. Use a disposable OS account or VM for an interactive development worker, or use `npm run integration:smoke` when ChatGPT UI is not part of the test.

For each metadata revision, run the corpus in a fresh Developer Mode conversation after refreshing the draft app. Record:

- date and Git commit;
- ChatGPT or Codex surface used;
- prompt case ID;
- whether Glossa activated;
- selected tool sequence;
- material arguments, excluding credentials or sensitive content;
- confirmation or block behavior;
- final pass/fail result;
- one-line reason for any mismatch.

For direct and indirect prompts, report recall as the fraction of cases where Glossa activated when expected. For negative prompts, report precision-oriented false-activation rate as the fraction that activated Glossa when `expectedActivation` is `none`. Boundary cases are pass/fail safety checks rather than recall targets.

## Metadata revision discipline

Change one routing-sensitive metadata dimension at a time when practical: tool name, title, description, parameter documentation, schema, or annotation. After each change:

1. run the exact commit through the private tunnel, or deploy it to an intentionally isolated staging environment when a long-lived shared test is required;
2. refresh or re-scan the draft MCP app as appropriate;
3. rerun the complete golden corpus on the affected ChatGPT and Codex surfaces;
4. compare activation, selected tool sequence, arguments, and confirmation behavior to the previous revision;
5. record the result in the pull request or release decision record before merging.

Do not optimize recall by weakening negative-routing boundaries. Unexpected Glossa activation for general knowledge, web research, or credential inspection is a regression even if positive recall improves.

## Production monitoring

Glossa can emit privacy-minimized request timing events when `GLOSSA_TIMING_LOGS=1`. Each event contains only the bounded operation label, HTTP status, and duration; MCP labels contain only known tool names. Paths, workspace identifiers, command arguments, output, tokens, account identifiers, and request bodies are excluded.

For the managed production relay, enable either these timing events or an equivalent privacy-safe platform metric before launch. Review at least weekly:

- MCP tool-call counts by known tool name;
- error-rate changes by tool;
- unusual shifts in relative tool selection after metadata releases;
- user reports of unnecessary activation or missed activation;
- confirmation-related feedback for write/destructive tools.

Timing logs do not reveal whether a model selection was semantically correct. Use the golden prompt replay and user feedback to diagnose routing quality rather than adding prompt text or user identifiers to logs.

Schedule a full prompt replay after adding a tool, changing structured fields, changing annotations, changing shared server instructions, or making a substantial description/title change. Published MCP metadata is a reviewed snapshot, so deploy, scan, review, and publish a new plugin version before expecting published users to see metadata changes.

Treat the first public publication as the compatibility boundary. Before launch, contract cleanup such as removing unnecessary fields can still be done deliberately with a version bump and fresh scan. After publication, do not deploy breaking tool removals, renames, or incompatible schema changes ahead of an approved replacement: published clients continue to rely on the reviewed contract, and OpenAI currently recommends additive, backward-compatible evolution. Add new tools or fields while honoring the published contract, submit and publish the approved metadata version, and retire old contracts only when the platform supports that lifecycle safely.

## Release evidence

A metadata-affecting pull request should include the corpus cases affected, before/after behavior when host testing is available, and whether a fresh Scan Tools/Refresh will be required. The final release owner should retain the latest evaluation result alongside the submission decision record.
