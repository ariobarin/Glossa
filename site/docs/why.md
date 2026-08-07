# Work with the project where it already lives.

Glossa connects ChatGPT to a user-selected local development workspace through an outbound worker.

That boundary is useful when the task depends on state that is already on the computer: an existing checkout, uncommitted changes, local build tools, test databases, emulators, generated files, or a development environment that is not available to a remote service.

Glossa does not add another model, planner, agent loop, or conversation store. It gives ChatGPT a narrow, visible path to the local project and lets the user choose among read-only access, guarded workspace edits, and explicit system-command access.

Use Glossa for work that genuinely requires the local workspace or its toolchain. General questions, writing, web research, and other built-in ChatGPT tasks should stay in ChatGPT without invoking Glossa.

<p class="docs-action-row"><a class="primary-action" href="/docs/quickstart">Quickstart</a></p>
