export const MCP_SERVER_INSTRUCTIONS = "Glossa gives access to the user's connected workspaces: files, images, and local command-line tools. Only call a Glossa tool when the user's current message explicitly asks you to inspect or change a connected workspace; do not inspect, edit, or run commands proactively just because Glossa is connected or because local files might help. Before any file change or command, require a clear request for that action. File paths are relative to each workspace root. Commands run with the local account's permissions, environment, and network access. Don't use Glossa to list, read, or reveal credentials, secrets, tokens, or environment variables.";

const EXPLICIT_REQUEST_ONLY = " Only use this tool after the user explicitly asks for the corresponding Glossa/local-workspace action in the current message.";

export const MCP_TOOL_COPY = {
  list_workspaces: {
    title: "Find Glossa Workspaces",
    description: "Lists online workspaces with their IDs, labels, and access permissions." + EXPLICIT_REQUEST_ONLY,
  },
  get_logout_instructions: {
    title: "Get Glossa Sign-Out Steps",
    description: "Returns sign-out and account-switching steps for Glossa.",
  },
  read_file: {
    title: "Read Workspace File",
    description: "Reads a complete UTF-8 file up to 1 MiB and returns its contents and SHA-256. Credential-bearing text is blocked. read_file_range returns sections within the same file-size limit." + EXPLICIT_REQUEST_ONLY,
  },
  view_image: {
    title: "View Workspace Image",
    description: "Reads a PNG, JPEG, or WebP image up to 4 MiB. Returns the image, MIME type, byte length, and SHA-256. If the image isn't shown to you, say so instead of reading the file another way." + EXPLICIT_REQUEST_ONLY,
  },
  list_files: {
    title: "List Workspace Files",
    description: "Lists files and directories, with optional recursion and cursor pagination. Skips links and, during recursion, common dependency and version-control directories." + EXPLICIT_REQUEST_ONLY,
  },
  search_text: {
    title: "Search Workspace Text",
    description: "Searches UTF-8 files up to 1 MiB each using literal text or JavaScript regex, with extension and glob filters. Skips links and common dependency/version-control directories. Returns matching lines and scan counts; truncation and skipped files indicate incomplete coverage." + EXPLICIT_REQUEST_ONLY,
  },
  read_file_range: {
    title: "Read Workspace File Range",
    description: "Reads complete lines from a UTF-8 file up to 1 MiB, returning at most 64 KiB per call. Includes nextLine and the full-file SHA-256. A single line over 64 KiB is rejected." + EXPLICIT_REQUEST_ONLY,
  },
  write_file: {
    title: "Create or Replace Workspace File",
    description: "Creates a UTF-8 file, or replaces an existing revision using expectedSha256. Maximum content: 1 MiB. Returns the new SHA-256 and byte length." + EXPLICIT_REQUEST_ONLY,
  },
  edit_file: {
    title: "Edit Workspace File",
    description: "Applies exact, non-overlapping text replacements to one file. Each oldText must match once. Returns the new SHA-256 and a bounded diff." + EXPLICIT_REQUEST_ONLY,
  },
  make_directory: {
    title: "Create Workspace Directory",
    description: "Creates a directory. recursive also creates missing parents." + EXPLICIT_REQUEST_ONLY,
  },
  delete_path: {
    title: "Delete Workspace Path",
    description: "Deletes a file or directory. Non-empty directories require recursive: true; the workspace root is protected." + EXPLICIT_REQUEST_ONLY,
  },
  move_path: {
    title: "Move Workspace Path",
    description: "Moves or renames a file or directory within the workspace. The destination must be unused." + EXPLICIT_REQUEST_ONLY,
  },
  run_command: {
    title: "Run Workspace Command",
    description: "Runs a command from the workspace directory. Returns status and up to 12 KiB of stdout/stderr; longer commands return a handle for status and output retrieval." + EXPLICIT_REQUEST_ONLY,
  },
  get_command: {
    title: "Check Workspace Command",
    description: "Returns a command's status and bounded stdout/stderr. Supports waiting for completion or output changes." + EXPLICIT_REQUEST_ONLY,
  },
  read_command_output: {
    title: "Read Workspace Command Output",
    description: "Reads up to 64 KiB of retained stdout or stderr. Each stream retains its first 1 MiB; completed records expire after five minutes or earlier eviction." + EXPLICIT_REQUEST_ONLY,
  },
  cancel_command: {
    title: "Stop Workspace Command",
    description: "Stops a running command and its process tree. Returns final status." + EXPLICIT_REQUEST_ONLY,
  },
} as const;
