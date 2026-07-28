# @ariobarin/glossa

This package contains the npm distribution of the `glossa` executable. Node.js
22.9 or newer is required for this installation method.

The recommended open-beta install on Windows, macOS, and Linux uses npm:

```shell
npm install --global @ariobarin/glossa@beta
```

Glossa also provides a self-contained direct installer that does not require
Node.js or npm.

Windows:

```powershell
irm https://glossa.sh/install | iex
```

macOS or Linux:

```shell
curl -fsSL https://glossa.sh/install.sh | sh
```

Open a terminal in the directory you want to expose, then run:

```shell
glossa
```

The hosted commands run the tracked scripts in `site`. They verify native
release checksums before installing. Use `glossa update` later with the original
installation method.

Glossa opens Google sign-in automatically when needed using OAuth Device Authorization Flow. Public client and resource identifiers are built in, so testers do not configure OAuth values. Use the same Google account when authorizing Glossa in ChatGPT.

OAuth and device credentials use the operating-system credential store. If it is unavailable, Glossa warns before using a restricted credential file.

Glossa signs in automatically and exposes the current directory. Pass a directory to expose a different workspace. The live session display shows the connection, authority, and recent activity.

The live display contains the full interactive workflow. Press `s` for account and device status, `r` to revoke a device, `l` to sign out, `u` to update, `d` for recent activity, or `q` or Ctrl+C to disconnect. Press `?` to see the keys at any time.

The same core actions remain available directly with `glossa status`, `glossa doctor`, `glossa devices`, `glossa devices revoke <id>`, `glossa login`, `glossa logout`, and `glossa update`. `glossa doctor` performs non-destructive readiness checks and accepts `--json` for scripts. JSON `ready` is false when warnings or failures remain, while the process exits nonzero only when a check fails. Status and device listings also accept `--json`.

The managed endpoint defaults to `https://mcp.glossa.sh`. Development deployments may override `GLOSSA_RELAY_ORIGIN` and `GLOSSA_WORKER_ORIGIN`. Plain HTTP is accepted only for loopback relay origins and loopback or private IPv4 worker origins.

Signing out removes local OAuth credentials, opens the browser logout page, and disconnects the current workspace. Other running Glossa sessions remain connected until stopped or revoked.
