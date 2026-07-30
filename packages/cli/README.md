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
release checksums before installing. Stop every running Glossa session, then
rerun the original installation method to update Glossa.

Glossa opens Google sign-in automatically when needed using OAuth Device Authorization Flow. Public client and resource identifiers are built in, so testers do not configure OAuth values. Use the same Google account when authorizing Glossa in ChatGPT.

OAuth and device credentials use the operating-system credential store. If it is unavailable, Glossa warns before using a restricted credential file.

Glossa signs in automatically and exposes the current directory. Pass a directory
to expose a different workspace. The responsive terminal interface shows the
workspace, device, and current connection or tool status.

Press `d` for compact tool history, `s` for account and device status, or `?`
for help. The activity view shows each local tool name and a compact form of its
input. Press `q` or Ctrl+C to disconnect.

Connected clients can modify files inside the exposed workspace and run commands
with the full environment and permissions of the operating-system account that
launched Glossa.

Use `glossa status` to show the signed-in account, relay, devices, and active
workspaces. Use `glossa devices revoke <id>` to revoke a device. Use
`glossa logout` to remove local OAuth credentials and open browser sign-out.

The managed endpoint defaults to `https://mcp.glossa.sh`. Development deployments may override `GLOSSA_RELAY_ORIGIN` and `GLOSSA_WORKER_ORIGIN`. Plain HTTP is accepted only for loopback relay origins and loopback or private IPv4 worker origins.

Other running Glossa sessions remain connected until stopped or revoked.
