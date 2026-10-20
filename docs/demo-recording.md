# Plugin submission demo recording

OpenAI requires a reviewer-accessible walkthrough URL for an MCP plugin. Glossa is for ChatGPT, so the recording shows the installed Glossa plugin working in ChatGPT only, side by side with the Glossa CLI on the computer whose project ChatGPT is working on. The left side shows the conversation; the right side shows each tool call arrive on the Activity screen as ChatGPT makes it.

## Before you record

- Copy the test project to a neutral folder with no personal path, for example `C:\glossa-sample`, from a fresh `npm run review:fixture:prepare`.
- Start Glossa on that folder in a terminal: `glossa --access system --label sample-project C:\glossa-sample`, and leave it on the **Activity** screen (`A`).
- Put ChatGPT on the left (about 60% of the screen) and the terminal on the right (about 40%). Hide ChatGPT's sidebar so no chat history shows.
- Start a new ChatGPT conversation and select Glossa with `@`. Make sure no other Glossa workspace is online for the same account, so ChatGPT doesn't have to choose.
- Close other windows and notifications. Never show a password, pairing code, token, email inbox, MFA screen, Auth0 dashboard, local absolute path, or machine name.

## Script

Paste each prompt, wait for the answer, and let the Activity screen settle before moving on.

| Step | Prompt | What should be visible |
| --- | --- | --- |
| 1 | `Search my local project for multiply, read the file that defines it, and explain its exported functions.` | `search_text` and `read_file` appear on the right; the answer explains `add` and `multiply` in `src/math.js`. |
| 2 | `List the files in my local project and tell me what the project is for.` | `list_files` and `read_file`; a small Node.js project exporting `add` and `multiply`. |
| 3 | `Read notes/review.txt in my local project, replace its contents with "OpenAI review completed." using the current revision, then read it back.` | `read_file`, then a guarded `write_file`, then the new text. |
| 4 | `In my local project, create the folder notes/scratch, write notes/scratch/draft.txt containing "draft", rename it to notes/scratch/final.txt, then delete notes/scratch recursively.` | `make_directory`, `write_file`, `move_path`, `delete_path`, and no command. |
| 5 | `Run npm test in my local project, wait for it to finish, and summarize the result.` | `run_command` runs on the right; 2 tests pass. |

If ChatGPT asks for confirmation before a write or command, approve it on camera; that shows the host safeguards working.

## After recording

- Trim the waits so the video lands near two minutes. Don't speed up or edit the answers themselves.
- Upload it so anyone with the link can watch without signing in or requesting access, for example as an unlisted YouTube video or a public Loom link.
- Watch it once at full screen and confirm that no password, pairing code, token, email address, local absolute path, machine name, or unrelated window appears anywhere in the recording.
- Confirm the tool names shown match the current scan; no stale tool names from an earlier MCP contract should appear.
- Rebuild the ZIP with `GLOSSA_PLUGIN_DEMO_URL` set to the link and upload it again; the portal reads the URL only from `plugin.json`.

To record a second take, recopy the test project first so `notes/review.txt` starts from its original text.

For a permission-boundary clip, restart Glossa with `--access workspace` and ask it to `Run npm test.`; it should report that system access is required. Keep credential-inspection prompts out of the public recording and in the reviewer regression suite instead.
