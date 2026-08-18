import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const markerName = ".glossa-review-fixture";
const markerContent = "glossa-app-review-fixture-v3\n";
const acceptedMarkerContents = new Set([
  markerContent,
  "glossa-app-review-fixture-v2\n",
  "glossa-plugin-review-fixture-v1\n",
]);
const reviewImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAAB4CAIAAABD1OhwAAAEZ0lEQVR42u3cv0sycRzAcX0S7MdQQ6TpH1AtCkmFnRB2dkRDQVCTEDS11NTe0lBE/0CER83RXBZBkQ0NrRe0pUsGGYFZh/B9hguJ9Hmyh3zyvr7fk367JK4Xn752qlMI4SCSpV+cAgI0EaCJAE0EaAI0EaCJAE0EaCJAE6CJ7J2rmoOcTidniuqhT196xIQmthxEtt5yVD/wiWpR9ZteJjSx5SACNBGgiQBNgCYCNBGgiQBNBGgCNBGgiQBNBGgiQBOgieyayxY/5aev7+adB1TvoL/0ztz3B4Mb0Dam/KdvhzWg7e34T4+GbJ4U2l7z/3lkYkL/DDg2IUxoeTQzqgEtrTBMA1o2W5gGtGyqMA1o2TxhGtCyScI0oGUzhGlAy6YH04AmanjQ9TwIGdKAlk0MpgFNBGgiu4O2y19zdh2ApsptbW0NDg4ODw9PTExkMhlrsaOj48Nhuq6HQqFwOBwKhXZ2dqzFq6srTdOi0ejY2Fg6na644nA4tre33W733d0dZ/tjooq+dHDFb5TpbPy9ZDI5Pj5umqYQYm1tTdM0a729vf39YQcHB4qi5HI5IUQul1MU5ejoSAgRDAbT6bQQYm9vb3Z2tuKKEGJycnJ5eTmRSIjGqPpfEKC/GbSmaZeXl9btp6enqampYrFYDlpV1YuLi9LdVCoVi8WEEN3d3Tc3N0II0zTPzs4qruTzeVVVr6+vp6enAQ3o2oL2+/0vLy/l6x9A+3y+QqFQulsoFHw+nxBC13Wv1zs/P39ycmJ9qXxlf39/Y2NDCNHf3//6+gpoQNcQtMfjsUBvbm6OjIz09PRUA/r5+dnv91u3Hx4eEolEIBBYWVmpuDI3NxcMBoeGhrxebzKZBPR/Ai3xk4q/FIlESluOXC7X3NxcEXQsFkulUqW75+fnmqZls9nSYjab9Xg85SvFYjEcDpc24ktLS4AGdA1B7+7ulp4Urq6utrW1VQR9eHioKMrj42PpSeHx8fH9/b3f77+9vRVCGIYxMDBQvnJ6erqwsGA9SD6f7+3tBfT7XA761uLxuGEYgUDA5/PF43GX6+0Mm6YZiUSs24qirK+vZzKZaDTqdrtN01xcXFRV1fqX38zMTEtLS1NTUyKR6Ozs/LCi6/ro6Kj1OK2trV1dXYZh9PX1cebfridUM0r/7UNbbHqpgk87qOfLXp/+driwQlwpJAI0EaCJAE2AJgI0USOBtulrOTABaCJAEwGa6CdB22tLygYa0EQNBtouY4/xDGgiQBPZHXT9/zVnvwFoecSgGdBEDQ+6Pgch4xnQ8uhBM6DlMYRmQMsjCc2AlscTmgEtjyo0A1oeW2gGtDzC0NwI/fyHNVrOavpBeFBmQsszqtHMhP5h098yrXEM6PqS/c+soQxoR92yrnJmg5jqHTReycZPCokATQRoAjQRoIkATQRoIkAToIkATQRoIkATffXFSTV9XwkRE5oI0CRvTl5qTExoIkATAZoI0ARoIkATAZoI0ESAJkAT2bvfud1WhFG+1jIAAAAASUVORK5CYII=",
  "base64",
);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const templateRoot = path.join(repositoryRoot, "review", "fixture-template");

const args = process.argv.slice(2);
const reset = args.includes("--reset");

if (args.some((arg) => arg !== "--reset") || args.length > 1) {
  throw new Error(
    "Usage: node scripts/prepare-app-review-workspace.mjs [--reset]",
  );
}

const target = path.join(repositoryRoot, ".review-workspace");
const backup = path.join(repositoryRoot, ".review-workspace.backup");

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function recognizedFixture(candidate) {
  const marker = await readFile(path.join(candidate, markerName), "utf8").catch(
    () => "",
  );
  return acceptedMarkerContents.has(marker);
}

if (await exists(backup)) {
  if (!(await recognizedFixture(backup))) {
    throw new Error(`Refusing to use an unrecognized backup: ${backup}`);
  }
  if (await exists(target)) {
    if (!(await recognizedFixture(target))) {
      throw new Error(
        `Refusing to remove a recognized backup while the target is unrecognized: ${target}`,
      );
    }
    await rm(backup, { recursive: true, force: false });
  } else {
    await rename(backup, target);
  }
}

const targetExists = await exists(target);
if (targetExists) {
  if (!reset) {
    throw new Error(
      `Target already exists: ${target}. Pass --reset to replace a recognized fixture.`,
    );
  }

  if (!(await recognizedFixture(target))) {
    throw new Error(`Refusing to reset an unrecognized directory: ${target}`);
  }
}

const staging = await mkdtemp(path.join(repositoryRoot, ".review-workspace-"));
try {
  await cp(templateRoot, staging, { recursive: true });
  await mkdir(path.join(staging, "assets"), { recursive: true });
  await writeFile(path.join(staging, "assets", "review.png"), reviewImage);
  await writeFile(path.join(staging, markerName), markerContent, "utf8");
  if (targetExists) await rename(target, backup);
  try {
    await rename(staging, target);
  } catch (error) {
    if ((await exists(backup)) && !(await exists(target))) {
      await rename(backup, target);
    }
    throw error;
  }
  if (await exists(backup)) {
    await rm(backup, { recursive: true, force: false });
  }
} catch (error) {
  if (await exists(staging)) {
    await rm(staging, { recursive: true, force: true });
  }
  throw error;
}

console.log(`Prepared Glossa app review workspace at ${target}`);
