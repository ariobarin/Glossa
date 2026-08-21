# Terms of use

These terms govern use of the managed Glossa relay, website, app, and published command-line client.

*Last updated August 21, 2026*

## Service

Glossa connects an authenticated MCP client to a local development project that the user explicitly exposes. Glossa is an execution bridge. It does not provide a model, agent loop, planner, conversation store, or command sandbox.

The user selects an access profile for each worker session. `read-only` permits structured file inspection, `workspace` permits structured reads and writes inside the exposed root, and `system` additionally permits command requests. Every new system command requires its complete escaped process input to be reviewable and separately approved in the local terminal before the worker starts it; commands that cannot be fully presented are denied.

> **System-command authority:** `glossa --access system` or a local HUD escalation allows connected clients to request commands. Each new command's complete process input is shown locally without truncation and starts only after approval; if the terminal cannot present all of it, Glossa denies the command. An approved command runs with the full environment, credentials, filesystem permissions, and network access of the operating-system account that launched Glossa. Commands can reach files outside the exposed root and may affect local or external systems. Approval prevents silent starts but is not a sandbox or guarantee that previously modified scripts are safe.

## Eligibility and authority

You must be at least 13, legally able to accept these terms, and authorized to use every computer, account, project, credential, and service you expose through Glossa. If you use Glossa for an organization, you represent that you have authority to accept these terms for that organization.

## Acceptable use

You may use Glossa only for lawful activity on systems and data you are authorized to access. You must not use it to compromise accounts or systems, distribute malware, evade access controls, expose another person's private data, violate third-party terms, or facilitate activity prohibited by applicable law or applicable usage policies.

Do not use the public Glossa app to request, transmit, discover, or return payment-card data subject to PCI DSS, protected health information, government identifiers, access credentials, or authentication secrets, including API keys, passwords, MFA or OTP codes, access tokens, or private keys.

## Your responsibilities

- Expose only a narrow project appropriate for the requested task.
- Select the least-privileged access profile that can complete the task.
- Understand system-command authority before enabling it, and review each local command prompt before approving it.
- Protect your computer, Glossa credentials, OAuth account, and connected MCP clients.
- Use a dedicated operating-system account, container, or virtual machine when stronger isolation is required.
- Stop the worker immediately if activity is unexpected.
- Verify changes, command results, and external side effects before relying on them.

## Your content

You retain your rights in source code, files, command input, and command output processed through Glossa. You grant Glossa permission to transmit and process that content only as needed to perform your requests, secure the service, and comply with law.

## Third-party services

Glossa depends on third-party services including ChatGPT or another MCP client, Auth0, Heroku, Vercel, GitHub, and npm. Their separate terms and policies apply to their services. Glossa is not made by or endorsed by OpenAI.

## Availability and changes

The relay uses process-local routing, so in-flight jobs may be interrupted by a service restart and are not a durable job queue. Glossa may change, limit, suspend, or discontinue service to protect users, the service, or third parties, comply with law, or maintain operations.

## No warranties

To the maximum extent permitted by law, Glossa is provided as available and without warranties of uninterrupted operation, fitness for a particular purpose, accuracy, security, or preservation of data. You are responsible for backups and for reviewing actions before and after execution.

## Limitation of liability

To the maximum extent permitted by law, the Glossa operator is not liable for indirect, incidental, special, consequential, or exemplary damages, or for lost data, credentials, profits, business, or goodwill arising from use of the service. These limitations do not apply where the law does not permit them.

## Suspension and termination

You may stop using Glossa at any time. Glossa may suspend or terminate access for misuse, security risk, legal requirements, or service discontinuation. Provisions that by their nature should survive termination, including responsibility, warranty, and liability terms, will survive.

## Changes and contact

Updated terms will be posted here with a new revision date. Questions can be submitted through [support](/support).
