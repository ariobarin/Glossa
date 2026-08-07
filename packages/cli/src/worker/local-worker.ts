import {
  DEFAULT_WORKER_ACCESS_PROFILE,
  workerPermissions,
  type WorkerAccessProfile,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";
import { CommandService } from "./command-service.js";
import { WorkerError } from "./errors.js";
import { FileService } from "./file-service.js";
import { PathPolicy } from "./path-policy.js";

export class LocalWorker {
  private constructor(
    readonly accessProfile: WorkerAccessProfile,
    readonly policy: PathPolicy,
    readonly files: FileService,
    readonly commands: CommandService,
  ) {}

  static async create(
    root: string,
    accessProfile: WorkerAccessProfile = DEFAULT_WORKER_ACCESS_PROFILE,
  ): Promise<LocalWorker> {
    const policy = await PathPolicy.create(root);
    return new LocalWorker(
      accessProfile,
      policy,
      new FileService(policy),
      new CommandService(policy),
    );
  }

  async handle(job: WorkerJob): Promise<WorkerResult> {
    try {
      const permissions = workerPermissions(this.accessProfile);
      if (
        (job.type === "write_file" || job.type === "edit_file") &&
        !permissions.writeFiles
      ) {
        throw new WorkerError(
          "write_access_disabled",
          "This worker was started without file-write access.",
        );
      }
      if (
        (job.type === "run_command" ||
          job.type === "get_command" ||
          job.type === "cancel_command") &&
        !permissions.runCommands
      ) {
        throw new WorkerError(
          "command_access_disabled",
          "This worker was started without system-command access.",
        );
      }

      let value: unknown;
      switch (job.type) {
        case "read_file":
          value = await this.files.readText(job.path);
          break;
        case "list_files":
          value = await this.files.listFiles({
            ...(job.path ? { path: job.path } : {}),
            ...(job.recursive === undefined ? {} : { recursive: job.recursive }),
            ...(job.cursor ? { cursor: job.cursor } : {}),
            ...(job.limit === undefined ? {} : { limit: job.limit }),
            timeoutMs: job.timeoutMs,
          });
          break;
        case "search_text":
          value = await this.files.searchText({
            query: job.query,
            ...(job.path ? { path: job.path } : {}),
            ...(job.caseSensitive === undefined
              ? {}
              : { caseSensitive: job.caseSensitive }),
            ...(job.maxResults === undefined ? {} : { maxResults: job.maxResults }),
            ...(job.extensions ? { extensions: job.extensions } : {}),
            timeoutMs: job.timeoutMs,
          });
          break;
        case "read_file_range":
          value = await this.files.readTextRange(
            job.path,
            job.startLine,
            job.lineCount,
            job.timeoutMs,
          );
          break;
        case "write_file":
          value = await this.files.writeText(
            job.path,
            job.content,
            job.expectedSha256,
          );
          break;
        case "edit_file":
          value = await this.files.editText(
            job.path,
            job.edits,
            job.expectedSha256,
          );
          break;
        case "run_command":
          value = await this.commands.start({
            ...(job.argv ? { argv: job.argv } : {}),
            ...(job.shellCommand ? { shellCommand: job.shellCommand } : {}),
            ...(job.stdin !== undefined ? { stdin: job.stdin } : {}),
            timeoutMs: job.timeoutMs,
            ...(job.waitMs === undefined ? {} : { waitMs: job.waitMs }),
          });
          break;
        case "get_command":
          value = await this.commands.get(
            job.commandId,
            job.waitMs,
            job.afterSequence,
          );
          break;
        case "cancel_command":
          value = await this.commands.cancel(job.commandId);
          break;
      }
      return { requestId: job.requestId, ok: true, value };
    } catch (error) {
      const workerError =
        error instanceof WorkerError
          ? error
          : new WorkerError("worker_failure", "The local worker operation failed.");
      return {
        requestId: job.requestId,
        ok: false,
        error: { code: workerError.code, message: workerError.message },
      };
    }
  }

  async shutdown(): Promise<void> {
    await this.commands.shutdown();
  }
}
