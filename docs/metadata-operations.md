# MCP metadata evaluation and operations

This runbook keeps Glossa's MCP discovery metadata measurable after the initial plugin submission. It complements the submission packet rather than replacing the portal's exact five-positive/three-negative review cases.

## Golden prompt corpus

`review/metadata-golden.json` is the versioned regression corpus for tool discovery and negative routing. It contains direct, indirect, follow-up, negative, and authority-boundary prompts. Keep prompts stable while evaluating one metadata change so differences remain attributable.

Run the structural check with:

```shell
npm run review:metadata:check
```

For each metadata revision, run the corpus in a fresh Developer Mode conversation after deploying and refreshing the MCP connection. Record:

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

1. deploy the exact commit;
2. refresh or re-scan the MCP connection as appropriate;
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
