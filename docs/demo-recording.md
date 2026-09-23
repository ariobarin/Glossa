# Plugin submission demo recording

Use this script for the MCP-backed public-submission recording. The goal is to show the reviewed Glossa production connection completing its core workflows on supported ChatGPT and Codex surfaces without exposing reviewer credentials, local absolute paths, private repositories, or unrelated desktop content.

## Recording setup

- Reset `.review-workspace` with `npm run review:fixture:prepare`.
- Run only the isolated fixture as `openai-review`; expose no other workspace.
- Use the dedicated reviewer account and complete authentication before recording. Never record a password, pairing code, OAuth token, Auth0 dashboard, browser password manager, or recovery flow.
- Use the production MCP connection with the final reviewed tool metadata. A local marketplace wrapper is not a prerequisite for a remote **With MCP** submission.
- Start fresh ChatGPT and Codex conversations so prior tool state does not affect routing.
- Crop the capture to the product surface. Do not show the local terminal if it displays an absolute path, machine name, account name, or unrelated applications.
- Keep the fixture pristine before each take.

## Suggested recording sequence

Aim for a concise recording that proves the product's distinct purpose and the main tool categories rather than demonstrating every one of the 16 tools.

### 1. ChatGPT: discover and inspect the local project

Prompt:

`Find where the multiply function is defined in my local project and explain it.`

Show that Glossa activates, discovers the isolated workspace when needed, uses structured search/read tools rather than a shell search, and returns the fixture's `multiply` function explanation. The result should not display a local absolute path or computer name.

### 2. ChatGPT: guarded local edit

Prompt:

`Read notes/review.txt, replace it with "OpenAI review completed." using the current revision, and read it back.`

Show the read → guarded write → read-back flow. The final response should contain the exact new text and no unrelated metadata.

Reset the fixture after this segment if the next take expects the original note.

### 3. ChatGPT: local toolchain command

Use the isolated fixture worker with explicit `system` access. Prompt:

`Run npm test in my local Glossa workspace and summarize the result.`

Show the command executing once and the final summary reporting two passing fixture tests. Do not display environment variables or any command unrelated to the fixture.

### 4. Codex: verify the same production connection

Start a new supported Codex surface connected to the same production Glossa MCP server and prompt:

`Search my local workspace for multiply, read the matching function, and explain it.`

Show Glossa selecting the same isolated workspace and structured tools on Codex. This segment verifies the claimed cross-surface workflow; it does not imply directory approval or publication.

### 5. Optional safety boundary clip

If the recording remains concise, include one permission boundary without exposing secrets:

With a `workspace` profile worker, prompt `Run npm test.` Show that command execution is not bypassed and the user is told that explicit `system` access is required. Do not demonstrate a credential-inspection prompt in the public recording; keep those cases in the reviewer regression suite.

## Final recording checks

Before using the URL in the submission portal, confirm:

- the recording is accessible to an OpenAI reviewer without requesting access;
- ChatGPT and Codex segments use the reviewed production connection;
- no password, pairing code, token, email inbox, MFA flow, Auth0 configuration, local absolute path, machine name, private repository, customer data, or Restricted Data appears anywhere in the video;
- the workflows shown match the current submitted tool metadata and descriptions;
- no stale UI or tool names from an earlier MCP contract appear;
- the recording shows enough context to understand that Glossa connects the model to a user-controlled local development workspace and existing local toolchain;
- the demo-recording URL is entered only after the final take is verified.
