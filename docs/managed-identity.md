# Managed identity operations

The managed Glossa service uses Auth0 with Google as its only upstream identity provider. Google accounts remain separate Glossa accounts. Do not merge accounts automatically by email address.

## Auth0 tenant contract

Maintain these settings for every Auth0 client that can request the managed Glossa audience, including the Native CLI client and dynamically registered MCP clients:

- Enable the `google-oauth2` social connection.
- Disable GitHub, database, passwordless, and every other identity connection.
- Keep Device Code and refresh-token grants enabled for the Native CLI client.
- Configure the Google connection to pass a static upstream `prompt` value of `select_account`.
- Set the relay's `GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX` to `google-oauth2|`.

Auth0 configures static upstream parameters inside the connection's existing `options` object. Preserve the complete existing object, including secrets, when adding:

```json
{
  "upstream_params": {
    "prompt": {
      "value": "select_account"
    }
  }
}
```

Never commit the Google client secret, an Auth0 Management API token, or an exported connection object containing secrets.

## Account switching

Running `glossa logout` deletes the CLI's local OAuth credentials and opens Auth0's browser logout endpoint. To switch Google accounts:

1. Stop every Glossa worker with Ctrl+C.
2. Run `glossa logout`.
3. In ChatGPT, open Glossa under **Settings > Plugins**, disconnect it, and connect it again. Use **Settings > Apps** if that is the label your workspace shows.
4. Choose the intended Google account during ChatGPT authorization.
5. Start Glossa and choose the same Google account.

The MCP `logout` tool returns the same browser logout URL and tells the model to present it to the user. The tool does not open the URL or revoke credentials itself.

## Release verification

Before treating an identity change as deployed:

1. Confirm Auth0 Universal Login offers no provider other than Google.
2. Confirm Google displays its account chooser even when an Auth0 session existed previously.
3. Complete CLI and ChatGPT authorization with the same Google account.
4. Start a worker and confirm `list_workspaces` returns it.
5. Attempt authentication with a non-Google Auth0 subject and confirm the relay returns `identity_provider_not_allowed` without creating an account.
