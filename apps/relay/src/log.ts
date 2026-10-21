export type LogLevel = "info" | "warn" | "error";

export type LogValue = string | number | boolean | null | readonly string[];

export type LogFields = Record<string, LogValue | undefined>;

export interface LogRecord extends LogFields {
  level: LogLevel;
  event: string;
}

export type LogSink = (record: LogRecord) => void;

/**
 * One JSON object per line. Heroku and its log drains add the timestamp,
 * dyno, and source, so the record carries only the event and its fields.
 */
export const consoleLogSink: LogSink = (record) => {
  const line = `${JSON.stringify(record)}\n`;
  if (record.level === "info") process.stdout.write(line);
  else process.stderr.write(line);
};

export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;

export function createLogger(sink: LogSink = consoleLogSink): Logger {
  return (level, event, fields = {}) => {
    try {
      sink({ ...fields, level, event });
    } catch {
      // Logging must never affect request handling.
    }
  };
}

export const log = createLogger();

const MAX_STACK_FRAMES = 12;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

/**
 * Describes an error without its message. Messages can quote request
 * content, for example a JSON parse failure that echoes part of a file, or a
 * database error that echoes a device name, so only the class name, a bounded
 * machine-readable code, and the stack frames are kept.
 */
export function safeErrorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const details = error as Error & { code?: unknown; type?: unknown };
  // V8 stacks start with "Name: message"; skip every line the message spans
  // so a multi-line message cannot smuggle text in as a frame.
  const messageLines = String(error.message).split("\n").length;
  const frames = (error.stack ?? "")
    .split("\n")
    .slice(messageLines)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_STACK_FRAMES);
  return {
    errorName: safeCode(error.name) ?? "Error",
    errorCode: safeCode(details.code),
    errorType: safeCode(details.type),
    stack: frames,
  };
}
