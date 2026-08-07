import { writeFileSync } from "node:fs";

process.stdout.write("sk-proj-");
setTimeout(() => process.stdout.write("A".repeat(32)), 25);
setTimeout(
  () => writeFileSync("notes/restricted-output-should-not-exist.txt", "bad"),
  1_000,
);
setTimeout(() => {}, 2_000);
