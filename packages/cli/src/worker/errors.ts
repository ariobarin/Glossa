import { workerErrorMessage } from "@glossa/protocol";

export class WorkerError extends Error {
  constructor(
    readonly code: string,
    message = workerErrorMessage(code),
  ) {
    super(message);
    this.name = "WorkerError";
  }
}
