# Maintainer guidance

## Purpose

Glossa is a thin execution bridge between ChatGPT and an explicitly exposed local coding workspace. Keep the hosted relay small and keep filesystem and process authority on the local worker.

Read `docs/architecture.md` and `docs/security.md` before changing trust boundaries.

## Rules

- Do not add an LLM, agent loop, conversation store, planner, or model provider integration.
- Keep source code, builds, command execution, and developer credentials on the worker.
- Enforce path and process boundaries on the worker, not only on the relay.
- Never make home, drive, or filesystem roots the default exposure.
- Treat command execution as the full authority of the worker account.
- Keep one relay process and one Postgres database until routing state has an external coordination design.
- Do not persist file contents, command arguments, command output, tokens, or local absolute paths.
- Keep dependencies exact.
- Do not commit credentials, browser state, logs, generated runtime state, or local paths.
- Update documentation when behavior, trust, deployment, or ownership changes.

## Workflow

1. State the smallest useful behavior.
2. Identify whether the relay, worker, protocol, or deployment owns it.
3. Run `npm run check`.
4. Verify the real CLI or HTTP flow when integration behavior changes.
5. Open one focused pull request.

## HUD visual changes

When changing the CLI HUD, run `npm run cli:hud-preview -- --screen <screen>` and inspect `.hud-preview/current.png` with Glossa's `view_image` tool before considering the UI done. Use `--width` and `--height` to exercise terminal sizes. The preview uses synthetic state and a real terminal parser, replaces the preview directory on every run, and prints the exact text frame to the command output. Use `npm run cli:hud-preview -- --clean` when the image is no longer needed. Do not capture a live HUD into the repository or ask the user to provide screenshots when the preview can reproduce the state.

## Account safety

When a service login is required, open the official page and let the user enter passwords and MFA. Never request, view, copy, or store those values.
