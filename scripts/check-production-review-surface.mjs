import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPackage = JSON.parse(
  await readFile(resolve(repositoryRoot, "packages/cli/package.json"), "utf8"),
);
const failures = [];

async function check(label, operation) {
  try {
    await operation();
    console.log(`PASS ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    console.error(`FAIL ${label}: ${message}`);
  }
}

async function request(url, init = {}) {
  return await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

async function publicText(url) {
  const response = await request(url);
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return await response.text();
}

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

function forbidMatch(source, pattern, message) {
  if (pattern.test(source)) throw new Error(message);
}

await check("homepage production positioning", async () => {
  const source = await publicText("https://glossa.sh/");
  requireMatch(
    source,
    /Connect ChatGPT to the <span>project on your computer\.<\/span>/,
    "homepage does not contain the production local-workspace headline",
  );
  requireMatch(
    source,
    /npm install -g @ariobarin\/glossa<\/code>/,
    "homepage does not contain the stable npm install command",
  );
  forbidMatch(
    source,
    /hero-footnote|One folder\. You choose the access\. Use the tools already there\./,
    "homepage restored the intentionally removed hero footnote",
  );
  forbidMatch(
    source,
    /reviewer|submission|Restricted Data|MCP contract/i,
    "homepage contains internal review or policy language",
  );
  forbidMatch(
    source,
    /other 50% of your plan/i,
    "homepage still contains usage-plan workaround positioning",
  );
  forbidMatch(
    source,
    /@ariobarin\/glossa@beta/i,
    "homepage still installs the beta npm tag",
  );
});

await check("quickstart is concise and accurate", async () => {
  const source = await publicText("https://glossa.sh/docs/quickstart");
  requireMatch(
    source,
    /workspace.*read and edit.*cannot run commands/is,
    "quickstart does not explain the default workspace access",
  );
  requireMatch(
    source,
    /developer-mode-and-mcp-apps-in-chatgpt/,
    "quickstart does not use the current Developer Mode guide",
  );
  requireMatch(
    source,
    /href="\/security"/,
    "quickstart does not link to the canonical security overview",
  );
  requireMatch(
    source,
    /system.*unsandboxed/is,
    "quickstart does not disclose the system command boundary",
  );
  requireMatch(
    source,
    /Choose <strong>OAuth<\/strong>, then <strong>Scan Tools<\/strong>\. Complete authorization.*wait for the scan, then <strong>Create<\/strong>/is,
    "quickstart does not match the current OAuth tool-scan sequence",
  );
  requireMatch(
    source,
    /Review permissions and requested actions/i,
    "quickstart does not tell users to review app permissions and actions",
  );
  forbidMatch(
    source,
    /restricted_data_blocked|authentication-secret egress guard|actual ChatGPT confirmation|reviewer account|submission packet/i,
    "quickstart contains internal review or detector details",
  );
  forbidMatch(
    source,
    /@ariobarin\/glossa@beta/i,
    "quickstart still installs the beta npm tag",
  );
  forbidMatch(
    source,
    /glossa --access (?:read-only|system)/i,
    "quickstart should keep alternate access commands in the operations guide",
  );
  forbidMatch(source, /open beta/i, "quickstart still labels Glossa as open beta");
});

await check("rationale keeps the product boundary simple", async () => {
  const source = await publicText("https://glossa.sh/docs/why");
  requireMatch(
    source,
    /a folder on your computer/i,
    "rationale does not state the product in user language",
  );
  requireMatch(
    source,
    /General questions, writing, and web research stay in ChatGPT/i,
    "rationale does not distinguish Glossa from general ChatGPT tasks",
  );
  forbidMatch(
    source,
    /reviewer|submission|restricted_data_blocked|data-loss-prevention/i,
    "rationale contains internal review or security implementation language",
  );
});

await check("security page is the canonical authority overview", async () => {
  const source = await publicText("https://glossa.sh/security");
  for (const profile of ["read-only", "workspace", "system"]) {
    requireMatch(
      source,
      new RegExp(`\\b${profile}\\b`, "i"),
      `security page does not document the ${profile} profile`,
    );
  }
  requireMatch(
    source,
    /Both the relay and the local worker enforce it/i,
    "security page does not disclose dual profile enforcement",
  );
  requireMatch(
    source,
    /full environment, credentials, filesystem permissions, and network access/i,
    "security page does not disclose system-command authority",
  );
  requireMatch(
    source,
    /payment-card data subject to PCI DSS.*protected health information.*government identifiers/is,
    "security page does not centralize the public sensitive-data boundary",
  );
  requireMatch(
    source,
    /not a complete data-loss-prevention system or sandbox/i,
    "security page overstates the recognizable-secret safeguard",
  );
  requireMatch(
    source,
    /credential-free dedicated operating-system account, container, or virtual machine/i,
    "security page does not describe the enforceable isolation option",
  );
});

await check("privacy page matches transient routing behavior", async () => {
  const source = await publicText("https://glossa.sh/privacy");
  requireMatch(
    source,
    /selected access profile/i,
    "privacy page does not disclose access-profile routing metadata",
  );
  requireMatch(
    source,
    /The relay is not a durable job queue/i,
    "privacy page does not disclose transient relay processing",
  );
  requireMatch(
    source,
    /may check text for recognizable authentication-secret patterns/i,
    "privacy page does not disclose recognizable-secret inspection",
  );
  requireMatch(
    source,
    /matched content is not returned to the client/i,
    "privacy page does not disclose blocked-value handling",
  );
  forbidMatch(
    source,
    /reviewer passwords|reviewer account|submission packet/i,
    "privacy page contains reviewer-only language",
  );
});

await check("terms page matches system-command authority", async () => {
  const source = await publicText("https://glossa.sh/terms");
  requireMatch(
    source,
    /System-command authority/i,
    "terms do not name system-command authority",
  );
  requireMatch(
    source,
    /least-privileged access profile/i,
    "terms do not require least-privileged profile selection",
  );
  requireMatch(
    source,
    /may affect local or external systems/i,
    "terms do not disclose local and external side effects",
  );
  requireMatch(
    source,
    /Do not use the public Glossa app to request, transmit, discover, or return payment-card data/i,
    "terms do not state the public sensitive-data restriction",
  );
});

await check("support page routes vulnerabilities privately", async () => {
  const source = await publicText("https://glossa.sh/support");
  requireMatch(
    source,
    /private vulnerability report/i,
    "support page does not link the private vulnerability process",
  );
  requireMatch(
    source,
    /Account deletion request/i,
    "support page does not document account-deletion requests",
  );
  requireMatch(
    source,
    /Ctrl\+C or <code>q<\/code>/i,
    "support page does not document immediate local disconnect",
  );
  requireMatch(
    source,
    /restricted_data_blocked/i,
    "support page does not explain restricted-data blocks",
  );
});

await check("relay health", async () => {
  const response = await request("https://mcp.glossa.sh/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "glossa-relay" });
});

await check("OAuth protected resource metadata", async () => {
  const response = await request(
    "https://mcp.glossa.sh/.well-known/oauth-protected-resource",
  );
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.resource, "https://mcp.glossa.sh/");
  assert.ok(Array.isArray(metadata.authorization_servers));
  assert.ok(metadata.authorization_servers.length >= 1);
  assert.deepEqual(metadata.scopes_supported, ["glossa:access"]);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
});

await check("unauthenticated MCP challenge", async () => {
  const response = await request("https://mcp.glossa.sh/mcp");
  assert.equal(response.status, 401);
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /Bearer resource_metadata="https:\/\/mcp\.glossa\.sh\/\.well-known\/oauth-protected-resource"/,
  );
});

const expectedReleaseAssets = [
  "glossa-windows-x64.exe",
  "glossa-windows-arm64.exe",
  "glossa-linux-x64",
  "glossa-linux-arm64",
  "glossa-macos-x64",
  "glossa-macos-arm64",
].flatMap((asset) => [asset, `${asset}.sha256`]);

await check("stable GitHub CLI release and native checksums", async () => {
  const response = await request(
    "https://api.github.com/repos/ariobarin/glossa/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "glossa-production-review-check",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `GitHub latest release returned ${response.status}; publish cli-v${cliPackage.version}`,
    );
  }
  const release = await response.json();
  if (release.tag_name !== `cli-v${cliPackage.version}`) {
    throw new Error(
      `latest stable GitHub release is ${release.tag_name ?? "missing"}; expected cli-v${cliPackage.version}`,
    );
  }
  assert.equal(release.draft, false, "latest GitHub release is still a draft");
  assert.equal(
    release.prerelease,
    false,
    "latest GitHub release is marked prerelease",
  );
  const assetNames = new Set(
    Array.isArray(release.assets)
      ? release.assets.map((asset) => asset?.name).filter(Boolean)
      : [],
  );
  const missing = expectedReleaseAssets.filter((asset) => !assetNames.has(asset));
  if (missing.length > 0) {
    throw new Error(`stable GitHub release is missing: ${missing.join(", ")}`);
  }
});

await check("stable npm latest tag", async () => {
  const response = await request(
    "https://registry.npmjs.org/@ariobarin%2Fglossa",
  );
  assert.equal(response.status, 200);
  const metadata = await response.json();
  const latest = metadata["dist-tags"]?.latest;
  if (latest !== cliPackage.version) {
    throw new Error(
      `npm latest is ${latest ?? "missing"}; expected ${cliPackage.version}`,
    );
  }
  assert.match(cliPackage.version, /^\d+\.\d+\.\d+$/);
});

if (failures.length > 0) {
  console.error("\nProduction review surface is not submission-ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Production review surface is ready for credentialed reviewer testing.");
}
