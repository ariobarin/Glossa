import { WORKER_ERROR_MESSAGES } from "@glossa/protocol";

export class WorkerError extends Error {
  constructor(
    readonly code: string,
    message = WORKER_ERROR_MESSAGES[code] ?? "The local worker operation failed.",
  ) {
    super(message);
    this.name = "WorkerError";
  }
}
