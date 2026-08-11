import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const version = process.argv[2];
const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Run this command through npm run cli:prepare");
  process.exit(1);
}

if (!version || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
  console.error("Usage: npm run cli:prepare -- 0.2.0-beta.1");
  process.exit(1);
}

run([
  "version",
  version,
  "--workspace",
  "@ariobarin/glossa",
  "--no-git-tag-version",
  "--allow-same-version",
]);
run(["run", "check"]);
run(["pack", "--workspace", "@ariobarin/glossa", "--dry-run"]);

console.log(`Prepared @ariobarin/glossa ${version}. No tag was created or published.`);

function run(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
