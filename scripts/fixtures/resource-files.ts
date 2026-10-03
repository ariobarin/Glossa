import { writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_READ_FILE_RANGE_BYTES, MAX_TEXT_BYTES } from "@glossa/protocol";

export async function createResourceFiles(root: string): Promise<void> {
  const files = {
    "limit.txt": ("x".repeat(1023) + "\n").repeat(MAX_TEXT_BYTES / 1024),
    "over.txt": "x".repeat(MAX_TEXT_BYTES + 1),
    "long-limit.txt": "é".repeat(MAX_READ_FILE_RANGE_BYTES / 2) + "\ntail",
    "long-over.txt": "é".repeat(MAX_READ_FILE_RANGE_BYTES / 2) + "x",
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, name), content);
  }
}
