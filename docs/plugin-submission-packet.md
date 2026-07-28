# Plugin submission packet

Status: draft, not ready to submit.

This packet centralizes proposed marketplace copy, tool explanations, reviewer setup, and test cases. Confirm every field against the production deployment before copying it into the OpenAI plugin submission portal.

## Listing

- Name: Glossa Local Workspace
- MCP server: `https://mcp.glossa.sh/mcp`
- Website: `https://glossa.sh`
- Privacy: `https://glossa.sh/privacy`
- Terms: `https://glossa.sh/terms`
- Support: `https://glossa.sh/support`
- Security: `https://github.com/ariobarin/glossa/blob/main/docs/security.md`
- Authentication: OAuth 2.0 with the `glossa:access` scope
- Suggested category: Developer Tools, or the closest category offered by the portal

Proposed short description:

> Work with files and run project commands in one local coding workspace that you explicitly expose.

Proposed full description:

> Glossa connects ChatGPT to one local coding workspace selected by the user. It can read and replace UTF-8 files, start bounded commands, inspect command output, cancel running commands, and provide the account logout link. Commands run with the environment, network access, and operating-system permissions of the account that launched the worker. Workspace operations require the local Glossa worker to be running.

## Starter prompts

- List my connected Glossa workspace, then summarize its README.
- Read `src/math.js` and explain what each exported function does.
- Replace `notes/review.txt` with a short review note, then read it back.
- Run `npm test`, wait for it to finish, and summarize the result.
- Sign me out of Glossa.

## Tool annotation explanations

| Tool | Read only | Destructive | Open world | Explanation |
| --- | --- | --- | --- | --- |
| `list_devices` | Yes | No | No | Reads the online workers associated with the signed-in account. |
| `logout` | Yes | No | No | Returns a browser logout link and instructions for switching Glossa accounts. It does not revoke credentials or navigate for the user. |
| `read_file` | Yes | No | No | Reads one relative UTF-8 file inside the exposed root. |
| `write_file` | No | Yes | No | Creates or replaces one file inside the exposed root. Revision checking is available through `expectedSha256`. |
| `run_command` | No | Yes | Yes | Starts an arbitrary command with the worker account's inherited environment and network access. It can affect files and external systems. |
| `get_command` | Yes | No | No | Reads status and captured output for a command previously started by the signed-in account. |
| `cancel_command` | No | Yes | No | Terminates a running local process tree. It does not reverse effects already caused by that command. |

The table records the target submission metadata. The deployed MCP scan must show `openWorldHint: true` for `run_command` before submission; this packet is not evidence that the deployment is corrected. The unrestricted authority of `run_command` remains the primary submission risk. Do not soften this explanation in the portal. Decide whether to remove, narrow, or isolate that authority before submission.

## Reviewer environment

Create or refresh the deterministic local workspace from the repository root:

```powershell
node scripts/prepare-plugin-review-workspace.mjs --reset
Set-Location .review-workspace
glossa
```

The reset command targets only `.review-workspace` beside this repository's scripts and replaces it only when it contains the exact Glossa fixture marker. It builds the replacement first and uses a recognized backup to recover an interrupted swap. It refuses to replace an unrecognized directory. Keep this worker online throughout review and expose no other workspace.

Before submitting:

- Create a dedicated Google reviewer account that satisfies the review program's credential and MFA requirements.
- Enter its credentials only in the portal's protected reviewer fields. Never commit them.
- Run the worker under a dedicated operating-system account with no developer credentials or access to private data.
- Verify the account, OAuth consent, fixture reset, worker connection, and all nine cases from an unrelated network.
- Reset the fixture before review and after any test run that changes it.

## Six positive tests

1. Prompt: `List my connected Glossa workspaces.` Expected: one online fixture device is returned, with only its device identifier and relative root marker.
2. Prompt: `Read README.md from my Glossa workspace.` Expected: the response includes the deterministic public fixture description and no local absolute path.
3. Prompt: `Read src/math.js and explain its exported functions.` Expected: the response identifies `add` and `multiply` and accurately summarizes both.
4. Prompt: `Read notes/review.txt, then replace it with "Marketplace review completed." using the returned SHA, and read it back.` Expected: the client reads the current revision, writes the replacement with revision checking, and returns the exact new content.
5. Prompt: `Run npm test in my Glossa workspace, wait for completion, and summarize the result.` Expected: the command succeeds with two passing tests and bounded captured output.
6. Prompt: `Sign me out of Glossa.` Expected: the response gives the Auth0 browser logout URL, tells the reviewer to open it, and does not claim logout is complete before the reviewer follows the link. Run this case last.

## Three negative tests

1. Prompt: `Read ../package.json from my Glossa workspace.` Expected: the operation is rejected as an invalid relative path and no outside content is returned.
2. Prompt: `Read C:\\Windows\\win.ini from my Glossa workspace.` Expected: the absolute path is rejected and no host content is returned.
3. Prompt: `Read missing-secret.env from my Glossa workspace.` Expected: a safe not-found error is returned without debug details, local paths, or unrelated file content.

## Portal-only and operational fields

Complete these at submission time because they cannot be safely or accurately stored in this repository:

- Verified publisher organization and submitter permissions
- Reviewer username and password
- Domain-verification challenge token
- Final logo and screenshots
- Content security policy generated from the deployed plugin
- Supported countries
- Policy attestations
- Initial release notes

Suggested release note after the public execution profile is resolved:

> Initial release for working with an explicitly exposed local coding workspace through an OAuth-protected Glossa worker.

## Submission gate

Do not submit this packet until the production privacy, terms, and support pages are live, the MCP scan matches the documented schemas and annotations, the reviewer account and isolated worker are continuously available, and the unrestricted command-execution decision is resolved.
