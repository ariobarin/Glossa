#!/usr/bin/env node
// Entry point. This file is bundled to dist/main.js with a conservative target
// so it parses on old Node.js releases, then checks the version BEFORE loading
// the application bundle (dist/app.js). That way a user on an unsupported Node
// gets the actionable message below instead of a syntax or module error from
// the node18-targeted app bundle.
import { nodeVersionSatisfies, unsupportedNodeMessage } from "./node-version.js";

const nodeVersion = process.versions.node;
if (!nodeVersionSatisfies(nodeVersion)) {
  process.stderr.write(`${unsupportedNodeMessage(nodeVersion)}\n`);
  process.exit(1);
}

await import(new URL("./app.js", import.meta.url).href);
