const output = [
  "BEGIN",
  "x".repeat(20_000),
  "MIDDLE-MARKER",
  "y".repeat(20_000),
  "END",
].join("\n");

process.stdout.write(output);
