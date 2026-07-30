# Terms of use

These terms govern use of the managed Glossa relay, website, plugin, and published command-line client.

*Last updated July 15, 2026*

## Service

Glossa connects an authenticated MCP client to one local coding workspace that the user explicitly exposes. Glossa is an execution bridge. It does not provide a model, agent loop, planner, conversation store, or command sandbox.

> **Command authority:** Starting the Glossa worker authorizes connected clients to modify files within the exposed root and run commands with the full permissions and environment of the operating-system account that launched it. Commands can access networks, developer credentials, and files outside the exposed file root.

## Eligibility and authority

You must be at least 13, legally able to accept these terms, and authorized to use every computer, account, workspace, credential, and service you expose through Glossa. If you use Glossa for an organization, you represent that you have authority to accept these terms for that organization.

## Acceptable use

You may use Glossa only for lawful activity on systems and data you are authorized to access. You must not use it to compromise accounts or systems, distribute malware, evade access controls, expose another person's private data, violate third-party terms, or facilitate activity prohibited by applicable law or OpenAI's usage policies.

## Your responsibilities

- Expose only a narrow workspace that is appropriate for the requested task.
- Review the exposed root and understand the documented command authority before leaving a worker connected.
- Protect your computer, Glossa credentials, OAuth account, and connected MCP clients.
- Use a dedicated operating-system account, container, or virtual machine when stronger isolation is required.
- Stop the worker immediately if activity is unexpected.
- Verify changes, command results, and external side effects before relying on them.

## Your content

You retain your rights in source code, files, command input, and command output processed through Glossa. You grant Glossa permission to transmit and process that content only as needed to perform your requests, secure the service, and comply with law.

## Third-party services

Glossa depends on third-party services including ChatGPT or another MCP client, Auth0, Heroku, Vercel, GitHub, and npm. Their separate terms and policies apply to their services. Glossa is not made by or endorsed by OpenAI.

## Availability and changes

Glossa is currently provided as an open beta. Features may change, fail, or be withdrawn. The relay uses process-local routing, so active jobs may be lost during a restart. Glossa may limit or disable access to protect users, the service, or third parties.

## No warranties

To the maximum extent permitted by law, Glossa is provided as available and without warranties of uninterrupted operation, fitness for a particular purpose, accuracy, security, or preservation of data. You are responsible for backups and for reviewing actions before and after execution.

## Limitation of liability

To the maximum extent permitted by law, the Glossa operator is not liable for indirect, incidental, special, consequential, or exemplary damages, or for lost data, credentials, profits, business, or goodwill arising from use of the service. These limitations do not apply where the law does not permit them.

## Suspension and termination

You may stop using Glossa at any time. Glossa may suspend or terminate access for misuse, security risk, legal requirements, or service discontinuation. Provisions that by their nature should survive termination, including responsibility, warranty, and liability terms, will survive.

## Changes and contact

These terms may change as the service develops. Updated terms will be posted here with a new revision date. Questions can be submitted through the [support page](/support).
