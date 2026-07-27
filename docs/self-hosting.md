# Self-hosting

Glossa is a managed service. Self-hosting is the optional alternative for people who prefer to operate the infrastructure themselves. A private installation consists of one public relay process, one Postgres database, one OAuth tenant, and the Glossa CLI on Windows, macOS, or Linux.

## Requirements

- Node.js 22.9 or newer and npm
- Postgres 17 with TLS enabled
- one public HTTPS origin for the relay
- an Auth0 tenant that issues JWT access tokens for your relay audience
- one Auth0 Native application with Device Code enabled for the CLI

Keep the relay at one process. Active worker routes and pending jobs live in relay memory, so horizontal scaling is not supported.

## Identity contract

Create an Auth0 API whose identifier is your relay audience, such as `https://mcp.example.com/`. Add these permissions:

- `glossa:access` for the MCP client
- `glossa:device` for CLI enrollment and device management

The Native application is a public client and needs Device Code and refresh token grants. Its allowed scopes must include `openid`, `profile`, `offline_access`, and `glossa:device`.

The relay accepts one Auth0 subject prefix. Managed Glossa defaults to `google-oauth2|`. A private installation using another Auth0 connection must set `GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX` to that connection's complete subject prefix, including the trailing `|` separator.

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
GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX=YOUR_PROVIDER|
```

Install, build, migrate, and start the relay:

```powershell
npm ci
npm run build
npm run migrate --workspace @glossa/relay
npm run start --workspace @glossa/relay
```

Terminate TLS in front of the relay. Confirm `https://mcp.example.com/healthz` returns an object with `ok` set to `true`.

## CLI

Use the same issuer, audience, and Native application when running the repository build:

Windows PowerShell:

```powershell
$env:GLOSSA_RELAY_ORIGIN = "https://mcp.example.com"
$env:GLOSSA_WORKER_ORIGIN = "https://mcp.example.com"
$env:GLOSSA_AUTH0_ISSUER = "https://YOUR_TENANT.auth0.com/"
$env:GLOSSA_AUTH0_AUDIENCE = "https://mcp.example.com/"
$env:GLOSSA_AUTH0_CLI_CLIENT_ID = "YOUR_NATIVE_CLIENT_ID"

Set-Location C:\path\to\glossa
npm ci
npm run build

Set-Location C:\path\to\a\project
node C:\path\to\glossa\packages\cli\dist\main.js
```

macOS or Linux:

```shell
export GLOSSA_RELAY_ORIGIN="https://mcp.example.com"
export GLOSSA_WORKER_ORIGIN="https://mcp.example.com"
export GLOSSA_AUTH0_ISSUER="https://YOUR_TENANT.auth0.com/"
export GLOSSA_AUTH0_AUDIENCE="https://mcp.example.com/"
export GLOSSA_AUTH0_CLI_CLIENT_ID="YOUR_NATIVE_CLIENT_ID"

cd /path/to/glossa
npm ci
npm run build

cd /path/to/a/project
node /path/to/glossa/packages/cli/dist/main.js
```

Only the selected project is exposed. The command process still has the full authority and environment of the operating-system account that launched it.

## ChatGPT

Add `https://mcp.example.com/mcp` as a custom MCP app in ChatGPT Developer Mode. This is a private app for your account or workspace. It is separate from the public Glossa app and the managed relay.

Review [architecture](architecture.md) and [security](security.md) before exposing the service to other users.
