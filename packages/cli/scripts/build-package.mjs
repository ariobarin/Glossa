import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

if (typeof packageJson.version !== "string") {
  throw new Error("CLI package version is missing");
}

await rm("dist", { recursive: true, force: true });

const applicationDefine = {
  __GLOSSA_VERSION__: JSON.stringify(packageJson.version),
  __GLOSSA_DISTRIBUTION__: JSON.stringify("npm"),
};

const omitInkDevtools = {
  name: "omit-ink-react-devtools",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]ink[\\/]build[\\/]devtools\.js$/ },
      () => ({ contents: "export {};", loader: "js" }),
    );
  },
};

// Application bundle, targeted at the supported Node.js release.
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/app.js",
  bundle: true,
  platform: "node",
  target: "node22.9",
  format: "esm",
  external: ["@napi-rs/keyring"],
  define: applicationDefine,
  plugins: [omitInkDevtools],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

// Tiny bootstrap entry (the published bin). Built against a conservative target
// so it parses on old Node.js and prints the version requirement before it
// loads the node22.9-targeted app bundle.
await build({
  entryPoints: ["src/bootstrap.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  define: {
    __GLOSSA_VERSION__: JSON.stringify(packageJson.version),
  },
});

const smoke = spawnSync(process.execPath, ["dist/main.js", "--version"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (smoke.status !== 0) {
  throw new Error(
    `Built CLI failed to start:\n${smoke.stderr || smoke.stdout || "unknown error"}`,
  );
}
