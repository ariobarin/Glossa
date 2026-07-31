import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const target = process.env.GLOSSA_BUN_TARGET;
const assetName = process.env.GLOSSA_STANDALONE_ASSET;
if (!target || !assetName) {
  throw new Error(
    "Set GLOSSA_BUN_TARGET and GLOSSA_STANDALONE_ASSET before building.",
  );
}

const packageJson = JSON.parse(
  await readFile(resolve("packages/cli/package.json"), "utf8"),
) as { version: string };
const version = process.env.GLOSSA_STANDALONE_VERSION ?? packageJson.version;
const output = resolve(
  process.env.GLOSSA_STANDALONE_OUTPUT_DIR ?? "dist/standalone",
  assetName,
);
await mkdir(dirname(output), { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve("packages/cli/src/main.ts")],
  compile: {
    target,
    outfile: output,
  },
  define: {
    __GLOSSA_VERSION__: JSON.stringify(version),
    __GLOSSA_DISTRIBUTION__: JSON.stringify("standalone"),
  },
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exitCode = 1;
}
