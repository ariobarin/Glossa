# Self-hosting

Glossa is a managed service. Self-hosting is the optional alternative for people who prefer to operate the infrastructure themselves. A private installation consists of one public relay process, one Postgres database, one OAuth tenant, and the Glossa CLI on Windows, macOS, or Linux.

## Requirements

- Docker, or Node.js 22.9 or newer and npm
- Postgres 17 with TLS enabled
- one public HTTPS origin for the relay
- an Auth0 tenant that issues JWT access tokens for your relay audience
- one Auth0 Regular Web Application for the control panel, where the CLI's pairing codes are redeemed

Keep the relay at one process. Active worker routes and pending jobs live in relay memory, so horizontal scaling is not supported.

## Identity contract

Create an Auth0 API whose identifier is your relay audience, such as `https://mcp.example.com/`. Add these permissions:

- `glossa:access` for the MCP client
- `glossa:device` for CLI 0.2.1 and older, which enroll with an OAuth token

Current CLIs hold no OAuth credentials. They print a pairing code, which you redeem on the relay's control panel, and then use only a revocable device credential.

The relay accepts an explicit allowlist of Auth0 provider prefixes and exact subjects. Managed Glossa defaults to the `google-oauth2|` prefix. A private installation may set `GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES` to one or more comma-separated connection prefixes, each including the trailing `|` separator, and `GLOSSA_AUTH0_ALLOWED_SUBJECTS` to one or more complete Auth0 subjects. Prefer exact subjects for isolated reviewer or service accounts so a whole connection is not admitted. The singular `GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX` setting has been removed; rename it to `GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES` before upgrading.

The MCP client must receive tokens from the same issuer, for the same audience, with `glossa:access`. Configure the client registration and consent flow using the current instructions from your identity provider and MCP client.

## Relay

Production mode connects to Postgres with TLS and verifies its certificate by default. Do not put SSL parameters in `DATABASE_URL`; Glossa rejects them so they cannot override the configured policy. Set `GLOSSA_DATABASE_CA_PEM` when your database provider uses a CA that is not in the system trust store. If the provider requires TLS but does not supply a verifiable certificate chain, set `GLOSSA_DATABASE_SSL_MODE=require`. This keeps the connection encrypted without verifying the server identity. The database in `compose.yaml` is for local development and is not a production self-hosting database.

Copy `.env.example` to `.env` and set at least:

```dotenv
NODE_ENV=production
GLOSSA_BIND_HOST=0.0.0.0
PORT=39100
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
GLOSSA_DATABASE_SSL_MODE=verify-full
# GLOSSA_DATABASE_CA_PEM="-----BEGIN CERTIFICATE-----..."
GLOSSA_PUBLIC_ORIGIN=https://mcp.example.com
GLOSSA_AUTH0_ISSUER=https://YOUR_TENANT.auth0.com/
GLOSSA_AUTH0_AUDIENCE=https://mcp.example.com/
GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES=YOUR_PROVIDER|
# GLOSSA_AUTH0_ALLOWED_SUBJECTS=YOUR_PROVIDER|EXACT_USER_ID
```

Build and run the relay image with the same `.env` file:

```powershell
docker build -t glossa-relay .
docker run --rm --env-file .env glossa-relay npm run migrate --workspace @glossa/relay
docker run --rm --env-file .env -p 127.0.0.1:39100:39100 glossa-relay
```

Or install, build, migrate, and start it directly with Node.js:

```powershell
npm ci
npm run build
npm run migrate --workspace @glossa/relay
npm run start --workspace @glossa/relay
```

Terminate TLS in front of the relay. The example binds HTTP to loopback for a proxy on the Docker host; use a private network instead when the proxy runs elsewhere. Do not expose the HTTP listener directly to the Internet. Confirm `https://mcp.example.com/healthz` returns an object with `ok` set to `true`.

### Usage counts

`npm run stats --workspace @glossa/relay` prints aggregate counts from the database: accounts signed up and admitted, new accounts, devices, and how many accounts had a paired device connect in the last 24 hours, 7 days and 30 days. It reads counts only, never names, tokens or identifiers. Pass `--exclude-subject <auth0-subject>` (repeatable) or set `GLOSSA_STATS_EXCLUDE_SUBJECTS` to a comma-separated list to leave your own accounts out (the heading shows how many accounts the subjects matched), and `--json` for machine-readable output.

## Control panel

The relay serves a small control panel at `/panel` for redeeming pairing codes and for listing and revoking the devices on your account, which is the recovery path when a computer is lost. New computers cannot pair without it. The panel is disabled unless all three panel variables are set.

Create an Auth0 Regular Web Application in the same tenant. Add `${GLOSSA_PUBLIC_ORIGIN}/panel/auth/callback` to its allowed callback URLs, for example `https://mcp.example.com/panel/auth/callback`. Then set:

```dotenv
GLOSSA_PANEL_CLIENT_ID=WEB_APPLICATION_CLIENT_ID
GLOSSA_PANEL_CLIENT_SECRET=WEB_APPLICATION_CLIENT_SECRET
GLOSSA_PANEL_SESSION_SECRET=LONG_RANDOM_VALUE_AT_LEAST_32_CHARACTERS
```

The session secret signs the panel's stateless session cookies. Keep it in the relay environment only; rotating it signs out every panel session. Panel sign-in uses the same issuer, audience, and subject allowlist as the rest of the relay.

## CLI

Point the CLI at your relay. It needs no identity settings:

Windows PowerShell:

```powershell
$env:GLOSSA_RELAY_ORIGIN = "https://mcp.example.com"
glossa
```

macOS or Linux:

```shell
GLOSSA_RELAY_ORIGIN="https://mcp.example.com" glossa
```

Redeem the printed pairing code at `https://mcp.example.com/panel`. Set `GLOSSA_WORKER_ORIGIN` only when workers must reach the relay at a different origin than browsers do.

The worker defaults to `workspace` access: structured reads and guarded writes stay inside the selected project, and commands are disabled. Start it with `--access read-only` for inspection or `--access system` only when commands are required. A system-profile command has the full environment, credentials, filesystem permissions, and network access of the operating-system account that launched it and is not confined to the selected project.

The relay rejects recognizable authentication secrets in mutation and command inputs, and the worker suppresses recognizable credential material in file and command results. This detector is deliberately high-confidence and incomplete. It cannot stop transformed values or a command that transmits data directly over the network. Operate sensitive `system` workers inside a credential-free OS account, container, or VM with appropriate network controls; do not present the detector as a sandbox.

## ChatGPT

Add `https://mcp.example.com/mcp` as a custom MCP app in ChatGPT Developer Mode. This is a private app for your account or workspace. It is separate from the public Glossa app and the managed relay.

Review [architecture](architecture.md) and [security](security.md) before exposing the service to other users.
