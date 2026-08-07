# Work with the project where it already lives.

Glossa connects ChatGPT to one project folder on your computer.

Use it when the task depends on local state that a remote service cannot see: an existing checkout, uncommitted changes, build tools, test databases, emulators, generated files, or the development environment already configured on the machine.

A small local worker makes an outbound connection to Glossa. You choose the folder and access level. The default allows file edits while keeping commands off; command access requires an explicit restart in `system` mode.

Glossa does not add another model, planner, agent loop, or conversation store. General questions, writing, and web research stay in ChatGPT. Use Glossa when the work genuinely needs the local project or its toolchain.

<p class="docs-action-row"><a class="primary-action" href="/docs/quickstart">Quickstart</a></p>
