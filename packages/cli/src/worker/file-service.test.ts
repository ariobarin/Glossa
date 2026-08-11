import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, opendir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_READ_FILE_RANGE_BYTES, MAX_SEARCH_TEXT_SNIPPET_CHARS } from "@glossa/protocol";
import { WorkerError } from "./errors.js";
import { FileService } from "./file-service.js";
import { PathPolicy, validateRelativePath } from "./path-policy.js";

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-test-"));
  context.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  return directory;
}

test("rejects Windows absolute and parent paths", () => {
  assert.throws(() => validateRelativePath("C:\\Windows\\win.ini"), {
    code: "absolute_path",
  });
  assert.throws(() => validateRelativePath("..\\outside.txt"), {
    code: "path_traversal",
  });
  assert.equal(validateRelativePath("src\\index.ts"), "src\\index.ts");
  if (process.platform !== "win32") {
    assert.equal(validateRelativePath("./C:\\notes.txt"), "./C:\\notes.txt");
    assert.equal(validateRelativePath("./..\\notes.txt"), "./..\\notes.txt");
  }
});

test("blocks linked directory traversal", async (context) => {
  const fixture = await temporaryDirectory(context);
  const root = path.join(fixture, "root");
  const outside = path.join(fixture, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
  await symlink(outside, path.join(root, "linked"), "junction");

  const policy = await PathPolicy.create(root);
  await assert.rejects(policy.resolveExisting(path.join("linked", "secret.txt")), {
    code: "linked_path",
  });
});

test("creates, moves, and deletes workspace paths without commands", async (context) => {
  const root = await temporaryDirectory(context);
  const files = new FileService(await PathPolicy.create(root));

  assert.deepEqual(await files.makeDirectory("nested/deep", true), {
    created: true,
  });
  assert.deepEqual(await files.makeDirectory("nested/deep", true), {
    created: false,
  });
  await files.writeText("nested/deep/note.txt", "hello");
  assert.deepEqual(
    await files.movePath("nested/deep/note.txt", "nested/note.txt"),
    { movedType: "file" },
  );
  await assert.rejects(files.readText("nested/deep/note.txt"), {
    code: "path_not_found",
  });
  assert.equal((await files.readText("nested/note.txt")).content, "hello");

  assert.deepEqual(await files.deletePath("nested/deep"), {
    deletedType: "directory",
  });
  await files.makeDirectory("tree/child", true);
  await files.writeText("tree/child/file.txt", "content");
  await assert.rejects(files.deletePath("tree"), {
    code: "directory_not_empty",
  });
  assert.deepEqual(await files.deletePath("tree", true), {
    deletedType: "directory",
  });
  await assert.rejects(files.readText("tree/child/file.txt"), {
    code: "path_not_found",
  });
});

test("guards structured path lifecycle boundaries", async (context) => {
  const root = await temporaryDirectory(context);
  const files = new FileService(await PathPolicy.create(root));

  await files.makeDirectory("source/child", true);
  await files.writeText("source/child/file.txt", "content");
  await assert.rejects(files.movePath("source", "source/child/moved"), {
    code: "invalid_destination",
  });
  assert.deepEqual(await files.movePath("source", "renamed"), {
    movedType: "directory",
  });
  assert.equal(
    (await files.readText("renamed/child/file.txt")).content,
    "content",
  );

  await files.writeText("occupied.txt", "occupied");
  await files.writeText("source.txt", "source");
  await assert.rejects(files.movePath("source.txt", "occupied.txt"), {
    code: "destination_exists",
  });
  await assert.rejects(files.deletePath("."), {
    code: "root_operation_refused",
  });
  await assert.rejects(files.movePath(".", "moved-root"), {
    code: "root_operation_refused",
  });
  await assert.rejects(files.makeDirectory("missing/child"), {
    code: "parent_not_found",
  });
});

test("applies exact guarded edits and returns a unified diff", async (context) => {
  const root = await temporaryDirectory(context);
  const files = new FileService(await PathPolicy.create(root));
  const original = await files.writeText(
    "note.txt",
    "const alpha = 1;\nbeta\ngamma\n",
  );

  const result = await files.editText(
    "note.txt",
    [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "gamma", newText: "G" },
    ],
    original.sha256,
  );

  assert.equal(result.replacements, 2);
  assert.equal(result.diffTruncated, false);
  assert.equal(
    result.diff,
    [
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1,1 +1,1 @@",
      "-const alpha = 1;",
      "+const ALPHA = 1;",
      "@@ -3,1 +3,1 @@",
      "-gamma",
      "+G",
      "",
    ].join("\n"),
  );
  assert.equal(
    await readFile(path.join(root, "note.txt"), "utf8"),
    "const ALPHA = 1;\nbeta\nG\n",
  );
});

test("rejects absent, ambiguous, overlapping, and stale edits", async (context) => {
  const root = await temporaryDirectory(context);
  const files = new FileService(await PathPolicy.create(root));
  const original = await files.writeText("note.txt", "same same abcdef");

  await assert.rejects(
    files.editText("note.txt", [{ oldText: "missing", newText: "x" }]),
    { code: "edit_not_found" },
  );
  await assert.rejects(
    files.editText("note.txt", [{ oldText: "same", newText: "x" }]),
    { code: "edit_ambiguous" },
  );
  await assert.rejects(
    files.editText("note.txt", [
      { oldText: "abcde", newText: "x" },
      { oldText: "cdef", newText: "y" },
    ]),
    { code: "edit_overlap" },
  );
  await assert.rejects(
    files.editText(
      "note.txt",
      [{ oldText: "abcdef", newText: "changed" }],
      "0".repeat(64),
    ),
    { code: "stale_revision" },
  );
  assert.equal(
    await readFile(path.join(root, "note.txt"), "utf8"),
    "same same abcdef",
  );
  assert.equal((await files.readText("note.txt")).sha256, original.sha256);
});

test(
  "preserves executable and regular file modes during edits",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await temporaryDirectory(context);
    const files = new FileService(await PathPolicy.create(root));

    for (const mode of [0o755, 0o644]) {
      const relativePath = `mode-${mode.toString(8)}.txt`;
      const target = path.join(root, relativePath);
      await writeFile(target, "before", "utf8");
      await chmod(target, mode);
      const original = await files.readText(relativePath);

      await files.editText(
        relativePath,
        [{ oldText: "before", newText: "after" }],
        original.sha256,
      );

      assert.equal((await stat(target)).mode & 0o777, mode);
    }
  },
);

test("writes atomically and rejects stale revisions", async (context) => {
  const root = await temporaryDirectory(context);
  const files = new FileService(await PathPolicy.create(root));

  const first = await files.writeText("note.txt", "first");
  assert.equal(first.bytes, 5);
  assert.deepEqual(await files.readText("note.txt"), {
    content: "first",
    sha256: first.sha256,
    bytes: 5,
  });

  await assert.rejects(
    files.writeText("note.txt", "second", "0".repeat(64)),
    { code: "stale_revision" },
  );
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "first");

  const second = await files.writeText("note.txt", "second", first.sha256);
  assert.equal(second.bytes, 6);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "second");
});

test("serializes guarded writes across file service instances", async (context) => {
  const root = await temporaryDirectory(context);
  const left = new FileService(await PathPolicy.create(root));
  const right = new FileService(await PathPolicy.create(root));

  for (let trial = 0; trial < 10; trial += 1) {
    const original = await left.writeText("note.txt", `original-${trial}`);
    const contents = [`left-${trial}`, `right-${trial}`] as const;
    const results = await Promise.allSettled([
      left.writeText("note.txt", contents[0], original.sha256),
      right.writeText("note.txt", contents[1], original.sha256),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal((rejected.reason as WorkerError).code, "stale_revision");
    const finalContent = await readFile(path.join(root, "note.txt"), "utf8");
    assert.ok(finalContent === contents[0] || finalContent === contents[1]);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith(".glossa-")),
      [],
    );
  }
});

test("serializes guarded writes through Windows file aliases", {
  skip: process.platform !== "win32",
}, async (context) => {
  const root = await temporaryDirectory(context);
  const longName = "long-alias-target-name.txt";
  await writeFile(path.join(root, longName), "content");
  const listing = execFileSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", "dir", "/x", root],
    { encoding: "utf8", windowsHide: true },
  );
  const shortName = listing.match(
    /(\S*~\S*)\s+long-alias-target-name\.txt\s*$/im,
  )?.[1];
  if (!shortName) {
    context.skip("The test volume does not expose 8.3 file aliases.");
    return;
  }

  assert.notEqual(longName.toLowerCase(), shortName.toLowerCase());
  const longFiles = new FileService(await PathPolicy.create(root));
  const shortFiles = new FileService(await PathPolicy.create(root));

  for (let trial = 0; trial < 10; trial += 1) {
    const original = await longFiles.readText(longName);
    const contents = [`long-${trial}`, `short-${trial}`] as const;
    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([
      longFiles.writeText(longName, contents[0], original.sha256),
      shortFiles.writeText(shortName, contents[1], original.sha256),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal((rejected.reason as WorkerError).code, "stale_revision");
    const finalContent = await readFile(path.join(root, longName), "utf8");
    assert.ok(finalContent === contents[0] || finalContent === contents[1]);
  }
});

test("lists deterministic files with cursor pagination and skips links", async (context) => {
  const fixture = await temporaryDirectory(context);
  const root = path.join(fixture, "root");
  const outside = path.join(fixture, "outside");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "a.txt"), "a", "utf8");
  await writeFile(path.join(root, "z.txt"), "z", "utf8");
  await writeFile(path.join(root, "src", "b.ts"), "b", "utf8");
  await writeFile(path.join(root, "src", "types.d.ts"), "d", "utf8");
  await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, path.join(root, "linked"), "junction");

  const files = new FileService(await PathPolicy.create(root));
  const first = await files.listFiles({ recursive: true, limit: 3 });
  assert.deepEqual(first.entries, [
    { path: "a.txt", type: "file", bytes: 1 },
    { path: "node_modules", type: "directory" },
    { path: "src", type: "directory" },
  ]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, "src");
  assert.equal(first.skippedLinks, 1);

  const second = await files.listFiles({
    recursive: true,
    cursor: first.nextCursor,
    limit: 10,
  });
  assert.deepEqual(second.entries, [
    { path: "src/b.ts", type: "file", bytes: 1 },
    { path: "src/types.d.ts", type: "file", bytes: 1 },
    { path: "z.txt", type: "file", bytes: 1 },
  ]);
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.entries.some((entry) => entry.path.includes("ignored")), false);
  assert.equal(second.entries.some((entry) => entry.path.includes("secret")), false);

  await assert.rejects(files.listFiles({ limit: 201 }), { code: "invalid_limit" });
});

test("searches literal text with compound suffixes and bounded snippets", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, "src", "types.d.ts"),
    "header\n?xTOKEN literal .* end\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "long.ts"),
    `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`,
    "utf8",
  );
  await writeFile(path.join(root, "one.ts"), "hit", "utf8");
  await writeFile(path.join(root, "two.ts"), "hit", "utf8");
  await writeFile(path.join(root, "src", "keep.ts"), "const alpha123 = 'hit';", "utf8");
  await writeFile(path.join(root, "src", "skip.ts"), "hit", "utf8");
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(root, "node_modules", "hidden.ts"), "hit", "utf8");

  const files = new FileService(await PathPolicy.create(root));
  const compound = await files.searchText({
    query: "token",
    extensions: [".d.ts"],
  });
  assert.deepEqual(compound.matches, [
    {
      path: "src/types.d.ts",
      line: 2,
      column: 3,
      text: "?xTOKEN literal .* end",
      lineTruncated: false,
    },
  ]);

  const literal = await files.searchText({
    query: ".*",
    extensions: [".d.ts"],
    caseSensitive: true,
  });
  assert.equal(literal.matches[0]?.path, "src/types.d.ts");
  assert.equal(literal.matches[0]?.column, 17);

  const regex = await files.searchText({
    query: "\\?xT(?:OKEN|EST)",
    matchMode: "regex",
    extensions: [".d.ts"],
  });
  assert.equal(regex.matches[0]?.path, "src/types.d.ts");
  assert.equal(regex.matches[0]?.column, 1);

  const filtered = await files.searchText({
    query: "hit",
    includeGlobs: ["src/**"],
    excludeGlobs: ["src/skip.ts"],
  });
  assert.deepEqual(filtered.matches.map((match) => match.path), ["src/keep.ts"]);
  assert.equal(filtered.matches.some((match) => match.path === "one.ts"), false);

  const bounded = await files.searchText({
    query: "needle",
    extensions: [".ts"],
  });
  const longMatch = bounded.matches.find((match) => match.path === "long.ts");
  assert.ok(longMatch);
  assert.equal(longMatch.lineTruncated, true);
  assert.ok(longMatch.text.length <= MAX_SEARCH_TEXT_SNIPPET_CHARS);
  assert.match(longMatch.text, /^\.\.\./);
  assert.match(longMatch.text, /\.\.\.$/);
  assert.match(longMatch.text, /NEEDLE/i);

  const limited = await files.searchText({ query: "hit", maxResults: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.matches.some((match) => match.path.includes("node_modules")), false);

  const binary = await files.searchText({ query: "text", extensions: [".bin"] });
  assert.equal(binary.matches.length, 0);
  assert.equal(binary.skippedFiles, 1);

  await assert.rejects(files.searchText({ query: "bad\nquery" }), {
    code: "invalid_search",
  });
  await assert.rejects(files.searchText({ query: "[", matchMode: "regex" }), {
    code: "invalid_search",
  });
  await assert.rejects(files.searchText({ query: "x", maxResults: 101 }), {
    code: "invalid_limit",
  });
});

test("searches regular directory entries without redundant lstat calls", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "one.ts"), "const needle = true;", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    {
      trustDirectoryEntryTypes: true,
      lstatPath: async () => {
        throw new Error("search should use Dirent types for regular entries");
      },
    },
  );

  const result = await files.searchText({ query: "needle" });
  assert.deepEqual(result.matches.map((match) => match.path), ["src/one.ts"]);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.skippedLinks, 0);
});

test("reads bounded complete line ranges with continuation metadata", async (context) => {
  const root = await temporaryDirectory(context);
  const files = new FileService(await PathPolicy.create(root));
  await writeFile(path.join(root, "range.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n", "utf8");

  const range = await files.readTextRange("range.txt", 2, 2);
  assert.equal(range.content, "two\nthree");
  assert.equal(range.startLine, 2);
  assert.equal(range.endLine, 3);
  assert.equal(range.totalLines, 4);
  assert.equal(range.nextLine, 4);
  assert.equal(range.contentBytes, Buffer.byteLength(range.content, "utf8"));
  assert.equal(range.sha256, (await files.readText("range.txt")).sha256);

  const half = "x".repeat(MAX_READ_FILE_RANGE_BYTES / 2);
  await writeFile(path.join(root, "bounded.txt"), `${half}\n${half}\n`, "utf8");
  const bounded = await files.readTextRange("bounded.txt", 1, 2);
  assert.equal(bounded.content, half);
  assert.equal(bounded.endLine, 1);
  assert.equal(bounded.nextLine, 2);
  assert.ok(bounded.contentBytes <= MAX_READ_FILE_RANGE_BYTES);

  await writeFile(
    path.join(root, "wide.txt"),
    "x".repeat(MAX_READ_FILE_RANGE_BYTES + 1),
    "utf8",
  );
  await assert.rejects(files.readTextRange("wide.txt"), { code: "line_too_large" });
  await assert.rejects(files.readTextRange("range.txt", 0, 1), {
    code: "invalid_range",
  });
  await assert.rejects(files.readTextRange("range.txt", 1, 501), {
    code: "invalid_limit",
  });
  await assert.rejects(files.readTextRange("range.txt", 9, 1), {
    code: "line_out_of_range",
  });
});

test("paginates recursive listings in global path order", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "a"));
  await writeFile(path.join(root, "a", "z.txt"), "z", "utf8");
  await writeFile(path.join(root, "a.b"), "b", "utf8");
  const files = new FileService(await PathPolicy.create(root));

  const first = await files.listFiles({ recursive: true, limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.path), ["a", "a.b"]);
  assert.equal(first.nextCursor, "a.b");

  const second = await files.listFiles({
    recursive: true,
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.deepEqual(second.entries.map((entry) => entry.path), ["a/z.txt"]);
  assert.equal(second.truncated, false);
});

test(
  "keeps encoded POSIX descendants monotonic across cursor pages",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await temporaryDirectory(context);
    await mkdir(path.join(root, "dir"));
    await writeFile(path.join(root, "dir", "a\\b.txt"), "needle", "utf8");
    const files = new FileService(await PathPolicy.create(root));

    const first = await files.listFiles({ recursive: true, limit: 1 });
    assert.deepEqual(first.entries.map((entry) => entry.path), ["dir"]);
    assert.equal(first.nextCursor, "dir");
    assert.equal(first.truncated, true);

    const second = await files.listFiles({
      recursive: true,
      cursor: first.nextCursor,
      limit: 1,
    });
    assert.deepEqual(
      second.entries.map((entry) => entry.path),
      ["./dir/a\\b.txt"],
    );
    assert.equal(second.truncated, false);
    assert.equal(second.nextCursor, undefined);
  },
);

test(
  "preserves discovered POSIX filenames with literal backslashes",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await temporaryDirectory(context);
    const relativePaths = ["dir\\name.txt", "C:\\notes.txt", "..\\notes.txt"];
    for (const relativePath of relativePaths) {
      await writeFile(path.join(root, relativePath), "needle", "utf8");
    }
    const files = new FileService(await PathPolicy.create(root));

    const returnedPaths = relativePaths.map((relativePath) => `./${relativePath}`);
    const listed = await files.listFiles();
    assert.deepEqual(
      listed.entries.map((entry) => entry.path).sort(),
      [...returnedPaths].sort(),
    );
    const searched = await files.searchText({ query: "needle" });
    assert.deepEqual(
      searched.matches.map((match) => match.path).sort(),
      [...returnedPaths].sort(),
    );
    for (const returnedPath of returnedPaths) {
      assert.equal((await files.readText(returnedPath)).content, "needle");
      assert.equal(
        (await files.readTextRange(returnedPath)).content,
        "needle",
      );
      assert.equal(
        (await files.searchText({ path: returnedPath, query: "needle" }))
          .matches[0]?.path,
        returnedPath,
      );
    }

    const editedPath = returnedPaths[0]!;
    const original = await files.readText(editedPath);
    const edited = await files.editText(
      editedPath,
      [{ oldText: "needle", newText: "updated" }],
      original.sha256,
    );
    assert.ok(edited.diff.startsWith(
      "--- a/./dir\\name.txt\n+++ b/./dir\\name.txt\n",
    ));
    assert.equal((await files.readText(editedPath)).content, "updated");
  },
);

test("applies a local deadline to structured scans", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "note.txt"), "note", "utf8");
  let observedDeadline = 0;
  const files = new FileService(
    await PathPolicy.create(root),
    {
      now: () => 1_000,
      beforeDeadline: async <T>(
        operation: Promise<T>,
        deadlineAt: number,
      ): Promise<T> => {
        void operation.catch(() => undefined);
        observedDeadline = deadlineAt;
        throw new WorkerError(
          "scan_timeout",
          "The structured repository operation exceeded its local deadline.",
        );
      },
    },
  );

  await assert.rejects(files.listFiles({ timeoutMs: 500 }), {
    code: "scan_timeout",
  });
  assert.equal(observedDeadline, 1_500);
});

test("retains timed out filesystem work until it settles", async (context) => {
  const root = await temporaryDirectory(context);
  let resolveOpen!: (handle: Awaited<ReturnType<typeof opendir>>) => void;
  let markOpenStarted!: () => void;
  let closed = false;
  let settled = false;
  const openStarted = new Promise<void>((resolve) => {
    markOpenStarted = resolve;
  });
  const lateHandle = {
    async read() {
      return null;
    },
    async close() {
      closed = true;
    },
  } as unknown as Awaited<ReturnType<typeof opendir>>;
  const files = new FileService(
    await PathPolicy.create(root),
    {
      openDirectory: async () => {
        markOpenStarted();
        return await new Promise((resolve) => {
          resolveOpen = resolve;
        });
      },
    },
  );

  const pending = files.listFiles({ timeoutMs: 5 });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await openStarted;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);

  resolveOpen(lateHandle);
  await assert.rejects(pending, { code: "scan_timeout" });
  assert.equal(closed, true);
});

test("returns a full page before expanding the overflow directory", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "a.txt"), "a", "utf8");
  await mkdir(path.join(root, "b"));
  await writeFile(path.join(root, "b", "child.txt"), "child", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    { maxRepositoryScanEntries: 2 },
  );

  const page = await files.listFiles({ recursive: true, limit: 1 });
  assert.deepEqual(page.entries, [{ path: "a.txt", type: "file", bytes: 1 }]);
  assert.equal(page.truncated, true);
  assert.equal(page.nextCursor, "a.txt");
  assert.equal(page.scannedEntries, 2);
});
test("returns a final-slot directory before scanning descendants", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "a"));
  await writeFile(path.join(root, "a", "one.txt"), "one", "utf8");
  await writeFile(path.join(root, "a", "two.txt"), "two", "utf8");
  await writeFile(path.join(root, "a", "three.txt"), "three", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    { maxRepositoryScanEntries: 3 },
  );

  const page = await files.listFiles({ recursive: true, limit: 1 });
  assert.deepEqual(page.entries, [{ path: "a", type: "directory" }]);
  assert.equal(page.truncated, true);
  assert.equal(page.nextCursor, "a");
  assert.equal(page.scannedEntries, 2);
});
test("allows EOF exactly at the recursive scan ceiling", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "a"));
  await writeFile(path.join(root, "a", "unavailable.txt"), "gone", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    {
      maxRepositoryScanEntries: 2,
      lstatPath: async (target) => {
        if (path.basename(target) === "unavailable.txt") {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return await lstat(target);
      },
    },
  );

  const page = await files.listFiles({ recursive: true, limit: 1 });
  assert.deepEqual(page.entries, [{ path: "a", type: "directory" }]);
  assert.equal(page.truncated, false);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.scannedEntries, 2);
});
test("enforces the scan ceiling while streaming one directory", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "a.txt"), "a", "utf8");
  await writeFile(path.join(root, "b.txt"), "b", "utf8");
  await writeFile(path.join(root, "c.txt"), "c", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    { maxRepositoryScanEntries: 2 },
  );

  await assert.rejects(files.listFiles(), { code: "scan_limit" });
  const search = await files.searchText({ query: "a" });
  assert.equal(search.truncated, true);
  assert.equal(search.scannedFiles, 0);
  assert.equal(search.scannedBytes, 0);
});

test("does not read beyond the remaining search byte budget", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "a.txt"), "aaaa", "utf8");
  await writeFile(path.join(root, "b.txt"), "bbbb", "utf8");
  const reads: string[] = [];
  const maximums: number[] = [];
  const expectedSizes: number[] = [];
  const files = new FileService(
    await PathPolicy.create(root),
    {
      maxSearchBytes: 5,
      readFileBytes: async (target, maximumBytes, expectedBytes) => {
        reads.push(path.basename(target));
        maximums.push(maximumBytes);
        expectedSizes.push(expectedBytes);
        return await readFile(target);
      },
    },
  );

  const result = await files.searchText({ query: "a" });
  assert.deepEqual(reads, ["a.txt"]);
  assert.deepEqual(maximums, [5]);
  assert.deepEqual(expectedSizes, [4]);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.scannedBytes, 4);
  assert.equal(result.truncated, true);
});

test("skips child directories that disappear during traversal", async (context) => {
  const root = await temporaryDirectory(context);
  const vanishing = path.join(root, "vanishing");
  await writeFile(path.join(root, "available.txt"), "needle", "utf8");
  await mkdir(vanishing);
  await writeFile(path.join(vanishing, "hidden.txt"), "needle", "utf8");
  const policy = await PathPolicy.create(root);
  const service = () => new FileService(
    policy,
    {
      lstatPath: async (target) => {
        const targetStat = await lstat(target);
        if (path.basename(target) === "vanishing") {
          await rm(target, { force: true, recursive: true });
        }
        return targetStat;
      },
    },
  );

  const listed = await service().listFiles({ recursive: true });
  assert.deepEqual(
    listed.entries.map((entry) => entry.path),
    ["available.txt"],
  );

  await mkdir(vanishing);
  await writeFile(path.join(vanishing, "hidden.txt"), "needle", "utf8");
  const searched = await service().searchText({ query: "needle" });
  assert.deepEqual(
    searched.matches.map((match) => match.path),
    ["available.txt"],
  );
  assert.equal(searched.skippedFiles, 1);
  assert.equal(searched.truncated, false);
});
test("skips directories replaced by links during traversal", async (context) => {
  const fixture = await temporaryDirectory(context);
  const root = path.join(fixture, "root");
  const outside = path.join(fixture, "outside");
  const changing = path.join(root, "changing");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(changing);
  await writeFile(path.join(root, "available.txt"), "available", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  let swapped = false;
  const files = new FileService(
    await PathPolicy.create(root),
    {
      lstatPath: async (target) => {
        const targetStat = await lstat(target);
        if (!swapped && path.basename(target) === "changing") {
          swapped = true;
          await rm(target, { force: true, recursive: true });
          await symlink(outside, target, "junction");
        }
        return targetStat;
      },
    },
  );

  const listed = await files.listFiles({ recursive: true });
  assert.deepEqual(
    listed.entries.map((entry) => entry.path),
    ["available.txt"],
  );
  assert.equal(listed.skippedLinks, 1);
});

test("counts files replaced by links as skipped links during search", async (context) => {
  const fixture = await temporaryDirectory(context);
  const root = path.join(fixture, "root");
  const outside = path.join(fixture, "outside.txt");
  const changing = path.join(root, "changing.txt");
  await mkdir(root);
  await writeFile(path.join(root, "available.txt"), "needle", "utf8");
  await writeFile(changing, "needle", "utf8");
  await writeFile(outside, "needle", "utf8");
  const linkProbe = path.join(root, "link-probe.txt");
  try {
    await symlink(outside, linkProbe, "file");
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      context.skip("Windows file symlink creation is unavailable.");
      return;
    }
    throw error;
  } finally {
    await rm(linkProbe, { force: true });
  }
  let swapped = false;
  const files = new FileService(
    await PathPolicy.create(root),
    {
      lstatPath: async (target) => {
        const targetStat = await lstat(target);
        if (!swapped && path.basename(target) === "changing.txt") {
          swapped = true;
          await rm(target, { force: true });
          await symlink(outside, target, "file");
        }
        return targetStat;
      },
    },
  );

  const search = await files.searchText({ query: "needle" });
  assert.deepEqual(search.matches.map((match) => match.path), ["available.txt"]);
  assert.equal(search.skippedLinks, 1);
  assert.equal(search.skippedFiles, 0);
  assert.equal(search.truncated, false);
});

test("skips files that become unavailable during search", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "available.txt"), "needle", "utf8");
  await writeFile(path.join(root, "unavailable.txt"), "needle", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    {
      readFileBytes: async (target) => {
        if (path.basename(target) === "unavailable.txt") {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return await readFile(target);
      },
    },
  );

  const search = await files.searchText({ query: "needle" });
  assert.deepEqual(search.matches.map((match) => match.path), ["available.txt"]);
  assert.equal(search.skippedFiles, 1);
  assert.equal(search.truncated, false);
});

test("skips unreadable child directories during recursive reads", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "protected"));
  await writeFile(path.join(root, "available.txt"), "needle", "utf8");
  await writeFile(path.join(root, "protected", "hidden.txt"), "needle", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    {
      openDirectory: async (directory) => {
        if (path.basename(directory) === "protected") {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return await opendir(directory);
      },
    },
  );

  const paged = await files.listFiles({ recursive: true, limit: 1 });
  assert.deepEqual(
    paged.entries.map((entry) => entry.path),
    ["available.txt"],
  );
  assert.equal(paged.truncated, false);
  assert.equal(paged.nextCursor, undefined);

  const listed = await files.listFiles({ recursive: true });
  assert.deepEqual(
    listed.entries.map((entry) => entry.path),
    ["available.txt"],
  );
  const search = await files.searchText({ query: "needle" });
  assert.deepEqual(search.matches.map((match) => match.path), ["available.txt"]);
  assert.equal(search.skippedFiles, 1);
});

test("skips overflow directories replaced by files", async (context) => {
  const root = await temporaryDirectory(context);
  const changing = path.join(root, "changing");
  await writeFile(path.join(root, "available.txt"), "available", "utf8");
  await mkdir(changing);
  await writeFile(path.join(changing, "hidden.txt"), "hidden", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    {
      lstatPath: async (target) => {
        const targetStat = await lstat(target);
        if (path.basename(target) === "changing") {
          await rm(target, { force: true, recursive: true });
          await writeFile(target, "now a file", "utf8");
        }
        return targetStat;
      },
    },
  );

  const page = await files.listFiles({ recursive: true, limit: 1 });
  assert.deepEqual(
    page.entries.map((entry) => entry.path),
    ["available.txt"],
  );
  assert.equal(page.truncated, false);
  assert.equal(page.nextCursor, undefined);
});
test("skips entries whose metadata becomes unavailable during listing", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "available.txt"), "available", "utf8");
  await writeFile(path.join(root, "unavailable.txt"), "unavailable", "utf8");
  const files = new FileService(
    await PathPolicy.create(root),
    {
      lstatPath: async (target) => {
        if (path.basename(target) === "unavailable.txt") {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return await lstat(target);
      },
    },
  );

  const listed = await files.listFiles();
  assert.deepEqual(listed.entries.map((entry) => entry.path), ["available.txt"]);
});
