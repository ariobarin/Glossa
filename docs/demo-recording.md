# Plugin submission demo recording

OpenAI requires a reviewer-accessible walkthrough URL for an MCP plugin. This is a two-minute script for the installed Glossa plugin: five ChatGPT prompts that match the portal's positive cases, then one Codex prompt that proves the same plugin works there. Record it in one take and cut the waiting time afterward.

## Before you record (5 minutes)

- Confirm the hosted reviewer worker is online: in ChatGPT, `List my connected Glossa workspaces.` should return only `openai-review` with system access.
- Use the installed **Glossa local** plugin in the ChatGPT desktop app, connected with the dedicated reviewer account, not only the raw custom MCP connection.
- Start a new ChatGPT conversation and a new Codex thread so earlier tool calls don't show.
- Close other windows and notifications. Never show a password, pairing code, token, email inbox, MFA screen, Auth0 dashboard, terminal, local absolute path, or machine name.
- Set the ChatGPT plugin permission to ask before actions if you want the confirmation prompts on screen; approve each one during the take.
- On Windows, record the app window with Snipping Tool (**Win+Shift+R**, then select the window) or Xbox Game Bar (**Win+Alt+R**).

## Script

Paste each prompt, wait for the answer, and keep the tool-call details visible for a moment before moving on. Optional voiceover lines are in italics.

| Time | Surface | Prompt | What should be visible |
| --- | --- | --- | --- |
| 0:00–0:10 | ChatGPT | none; show the composer with Glossa selected | *"Glossa lets ChatGPT work on a project on your computer. This is a small test project running with system access."* |
| 0:10–0:35 | ChatGPT | `Search my local project for multiply, read the file that defines it, and explain its exported functions.` | `search_text` and `read_file` on `openai-review`; the answer explains `add` and `multiply` in `src/math.js`. |
| 0:35–0:50 | ChatGPT | `List the files in my local project and tell me what the project is for.` | `list_files` and `read_file`; a small Node.js test project exporting `add` and `multiply`. |
| 0:50–1:10 | ChatGPT | `Read notes/review.txt in my local project, replace its contents with "OpenAI review completed." using the current revision, then read it back.` | `read_file`, then `write_file` with the revision, then the new text. *"Edits check the current version, so nothing is overwritten blindly."* |
| 1:10–1:25 | ChatGPT | `In my local project, create the folder notes/scratch, write notes/scratch/draft.txt containing "draft", rename it to notes/scratch/final.txt, then delete notes/scratch recursively.` | `make_directory`, `write_file`, `move_path`, `delete_path`, and no command. |
| 1:25–1:40 | ChatGPT | `Run npm test in my local project, wait for it to finish, and summarize the result.` | `run_command`; 2 tests pass. *"Commands only run when the user starts Glossa with system access."* |
| 1:40–2:00 | Codex | `Search my local project for multiply, read the matching function, and explain it.` | The same Glossa plugin and `openai-review` workspace answer from Codex. |

If ChatGPT asks for confirmation before a write or command, approve it on camera; that shows the host safeguards working.

## After recording

- Trim the waits so the video lands near two minutes. Don't speed up or edit the answers themselves.
- Upload it so anyone with the link can watch without signing in or requesting access, for example as an unlisted YouTube video or a public Loom link.
- Watch it once at full screen and confirm that no password, pairing code, token, email address, local absolute path, machine name, or unrelated window appears anywhere in the recording.
- Confirm the tool names shown match the current scan; no stale tool names from an earlier MCP contract should appear.
- Enter the URL in the portal under **Review information → Review details → Demo recording URL**, or rebuild the ZIP with `GLOSSA_PLUGIN_DEMO_URL` set.

The `notes/review.txt` change and the scratch folder are safe to leave; the hosted worker resets its files daily. To record a second take right away, the same prompts work again unchanged.

For a permission-boundary clip, use a separate `workspace` worker and `Run npm test.`; it should report that system access is required. Keep credential-inspection prompts out of the public recording and in the reviewer regression suite instead.
