# Managed identity and reviewer access

The managed Glossa service uses Auth0. Regular users authenticate through the Google social connection. OpenAI review uses a separate, dedicated Auth0 database account so a reviewer is not dependent on an operator's personal account, Google account chooser state, inaccessible email, SMS, or multi-factor authentication.

Google and database identities remain separate Glossa accounts. Never merge accounts automatically by email address.

## Auth0 tenant contract

Maintain these settings for every Auth0 client that can request the managed Glossa audience, including the Native CLI client and dynamically registered MCP clients:

- Enable the `google-oauth2` social connection for regular users.
- Keep Device Code and refresh-token grants enabled for the Native CLI client.
- Configure the Google connection to pass a static upstream `prompt` value of `select_account`.
- Disable every unapproved social, enterprise, passwordless, and database connection.
- Configure the relay's identity allowlist explicitly. A valid token is accepted only when its subject matches an approved provider prefix or exact subject.

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

Never commit a Google client secret, Auth0 Management API token, reviewer password, reviewer Auth0 subject, exported connection object, access token, refresh token, or device secret.

## Dedicated OpenAI reviewer account

Before submission, create one isolated database account solely for OpenAI review and enable that database connection only for the managed MCP and Native CLI clients that the reviewer must exercise.

Required reviewer properties:

- public signup is disabled;
- the account is created manually and has no access to operator or customer data;
- the account is pre-verified and does not require email access;
- login does not require MFA, SMS, passwordless email, CAPTCHA, a private network, or an operator approval step;
- the password is strong, unique, and delivered only through the OpenAI review credential fields;
- the account remains usable for the entire review window and is rotated or revoked after review;
- the reviewer can use the same username and password in ChatGPT OAuth and the CLI Device Authorization flow.

After creating the account, copy its exact Auth0 `user_id` from the tenant dashboard into the managed relay's secret configuration. Keep Google as the only provider-wide prefix and admit the reviewer by exact subject:

```dotenv
GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES=google-oauth2|
GLOSSA_AUTH0_ALLOWED_SUBJECTS=auth0|REVIEWER_USER_ID
```

Do not use `auth0|` as a provider-wide prefix for managed review. That would admit every database identity in the tenant rather than only the dedicated reviewer. The relay accepts at most eight unique provider prefixes and 32 unique exact subjects. Existing self-hosted deployments may keep the legacy singular `GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX`; do not set both singular and plural prefix variables.

Do not place the reviewer subject or credentials in this repository, test fixtures, deployment logs, screenshots, support issues, or pull-request descriptions.

## Reviewer onboarding runbook

1. Prepare the deterministic review workspace with `node scripts/prepare-app-review-workspace.mjs --reset`.
2. Unpair any existing pairing on the fixture machine with `glossa unpair`.
3. Start the fixture with `glossa --access system --label openai-review .review-workspace` using a dedicated operating-system account or isolated virtual machine.
4. Complete CLI authorization with the reviewer username and password.
5. In ChatGPT, connect Glossa with the same credentials and scan tools.
6. Confirm `list_workspaces` returns exactly one labeled workspace with `accessProfile: "system"` and all three permissions set to `true`.
7. Run the positive and negative prompts in the [app submission packet](app-submission-packet.md).
8. Stop the worker after the session. Keep the reviewer account available until OpenAI closes the review.

The review fixture contains only synthetic files and deterministic scripts. The reviewer worker must not inherit operator cloud credentials, production source repositories, SSH agents, personal browser sessions, or customer data.

## Account switching

The CLI keeps no account session: a computer is either paired to an account or not. Pairing redeems a CLI pairing code on the control panel, which uses the signed-in Auth0 browser session. To switch accounts:

1. Stop every Glossa worker with Ctrl+C or `q`.
2. Run `glossa unpair`.
3. End the Auth0 browser session so the next panel sign-in offers the account chooser. The MCP `get_logout_instructions` tool returns the browser logout URL.
4. Disconnect Glossa under **Settings > Apps** in ChatGPT and connect it again with the intended account.
5. Start Glossa and redeem its new pairing code on the panel while signed in to the intended identity.

The MCP `get_logout_instructions` tool returns equivalent sign-out steps and a browser logout URL. It does not open the URL, revoke credentials, or sign the user out by itself.

## Release verification

Before treating an identity change as deployed:

1. Confirm regular login offers the intended Google connection and no unapproved provider.
2. Confirm Google displays an account chooser even when an Auth0 session existed previously.
3. Confirm the dedicated reviewer account works in both ChatGPT OAuth and CLI Device Authorization without MFA or external account access.
4. Start a reviewer fixture worker and confirm `list_workspaces` returns its profile and permissions.
5. Attempt authentication with a different `auth0|` database subject and confirm the relay returns `identity_provider_not_allowed` without creating an account.
6. Attempt authentication with a subject from an unlisted provider and confirm the same denial.
7. Confirm prefix configuration rejects duplicates, missing `|` separators, empty values, and simultaneous plural and legacy singular settings.
8. Confirm exact-subject configuration rejects malformed, empty, and duplicate entries.
9. Confirm secrets, the reviewer subject, and reviewer credentials are absent from Git history, build output, site content, logs, and the final submission packet.
