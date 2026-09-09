import {
  DEFAULT_COMMAND_FAST_WAIT_MS,
  DEFAULT_COMMAND_OUTPUT_RANGE_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_STRUCTURED_READ_TIMEOUT_MS,
} from "@glossa/protocol";
import type { ActivityCall } from "./activity-call.js";

export { activityCallFromJob } from "./activity-call.js";

export type HudActivityMode = "compact" | "detailed";
export type HudActivityCall = ActivityCall;

export interface HudActivityDetailField {
  label: string;
  value: string;
}

const INLINE_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

function escapeCodePoint(codePoint: number): string {
  const hexadecimal = codePoint.toString(16);
  return codePoint <= 0xffff
    ? `\\u${hexadecimal.padStart(4, "0")}`
    : `\\u{${hexadecimal}}`;
}

export function escapeActivityText(value: string, quote = false): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\\") escaped += "\\\\";
    else if (quote && character === '"') escaped += '\\"';
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else if (
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      INLINE_DEFAULT_IGNORABLE.test(character) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      escaped += escapeCodePoint(codePoint);
    } else escaped += character;
  }
  return escaped;
}

function quote(value: string): string {
  return `"${escapeActivityText(value, true)}"`;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) {
    return `${kibibytes.toFixed(kibibytes < 10 ? 1 : 0)} KiB`;
  }
  return `${(kibibytes / 1024).toFixed(1)} MiB`;
}

function truncateMiddle(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  const visible = width - 1;
  const leading = Math.max(1, Math.floor(visible * 0.45));
  const trailing = visible - leading;
  let start = value.slice(0, leading);
  if (/[\ud800-\udbff]$/.test(start)) start = start.slice(0, -1);
  let end = trailing > 0 ? value.slice(-trailing) : "";
  if (/^[\udc00-\udfff]/.test(end)) end = end.slice(1);
  return `${start}…${end}`;
}

function fitPath(path: string, width: number, quoted = false): string {
  const wrapper = quoted ? 2 : 0;
  const innerWidth = Math.max(0, width - wrapper);
  const escaped = escapeActivityText(path, quoted);
  if (escaped.length <= innerWidth) return quoted ? `"${escaped}"` : escaped;

  const slash = path.includes("/") ? "/" : path.includes("\\") ? "\\" : undefined;
  if (!slash) {
    const fitted = truncateMiddle(escaped, innerWidth);
    return quoted ? `"${fitted}"` : fitted;
  }

  const parts = path.split(slash).map((part) => escapeActivityText(part, quoted));
  if (parts.length < 3) {
    const fitted = truncateMiddle(escaped, innerWidth);
    return quoted ? `"${fitted}"` : fitted;
  }

  const first = parts[0]!;
  const tail = [parts.at(-1)!];
  for (let index = parts.length - 2; index > 0; index -= 1) {
    const candidateTail = [parts[index]!, ...tail];
    const candidate = `${first}${slash}…${slash}${candidateTail.join(slash)}`;
    if (candidate.length > innerWidth) break;
    tail.unshift(parts[index]!);
  }
  const candidate = `${first}${slash}…${slash}${tail.join(slash)}`;
  const filename = parts.at(-1)!;
  const collapsedFilename = `…${slash}${filename}`;
  const fitted = candidate.length <= innerWidth
    ? candidate
    : collapsedFilename.length <= innerWidth
      ? collapsedFilename
      : truncateMiddle(filename, innerWidth);
  return quoted ? `"${fitted}"` : fitted;
}

function compactToken(value: string): string {
  const escaped = escapeActivityText(value, true);
  return /^[A-Za-z0-9_@./:=+,-]+$/.test(escaped) && escaped.length > 0
    ? escaped
    : `"${escaped}"`;
}

function fitToken(token: string, width: number): string {
  if (width <= 0) return "";
  if (token.length <= width) return token;
  if (token.startsWith('"') && token.endsWith('"') && width >= 3) {
    return `"${truncateMiddle(token.slice(1, -1), width - 2)}"`;
  }
  return truncateMiddle(token, width);
}

function fitDelimitedTokens(
  prefix: string,
  tokens: string[],
  suffix: string,
  width: number,
  separator: string,
): string {
  const full = `${prefix}${tokens.join(separator)}${suffix}`;
  if (full.length <= width || tokens.length <= 2) return truncateMiddle(full, width);

  const left: string[] = [tokens[0]!];
  const right: string[] = [tokens.at(-1)!];
  let leftIndex = 1;
  let rightIndex = tokens.length - 2;

  while (leftIndex <= rightIndex) {
    let changed = false;
    const withLeft = `${prefix}${[...left, tokens[leftIndex]!, "…", ...right].join(separator)}${suffix}`;
    if (withLeft.length <= width) {
      left.push(tokens[leftIndex]!);
      leftIndex += 1;
      changed = true;
    }
    if (leftIndex > rightIndex) break;
    const withRight = `${prefix}${[...left, "…", tokens[rightIndex]!, ...right].join(separator)}${suffix}`;
    if (withRight.length <= width) {
      right.unshift(tokens[rightIndex]!);
      rightIndex -= 1;
      changed = true;
    }
    if (!changed) break;
  }

  const candidate = `${prefix}${[...left, "…", ...right].join(separator)}${suffix}`;
  if (candidate.length <= width) return candidate;

  const minimalOverhead = prefix.length + suffix.length + separator.length * 2 + 1;
  const available = width - minimalOverhead;
  if (available < 2) {
    const structural = `${prefix}…${suffix}`;
    return structural.length <= width ? structural : truncateMiddle(structural, width);
  }

  const first = tokens[0]!;
  const last = tokens.at(-1)!;
  let firstWidth = Math.min(first.length, Math.max(1, Math.floor(available / 2)));
  let lastWidth = available - firstWidth;
  if (last.length < lastWidth) {
    lastWidth = last.length;
    firstWidth = available - lastWidth;
  } else if (first.length < firstWidth) {
    firstWidth = first.length;
    lastWidth = available - firstWidth;
  }
  return `${prefix}${fitToken(first, firstWidth)}${separator}…${separator}${fitToken(last, lastWidth)}${suffix}`;
}

function compactArgv(argv: string[], width: number): string {
  return fitDelimitedTokens("", argv.map(compactToken), "", width, " ");
}

function detailedArgv(argv: string[], width: number): string {
  return fitDelimitedTokens("argv [", argv.map(quote), "]", width, ", ");
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function appendDetails(target: string, details: string[], width: number): string {
  let result = target;
  for (const detail of details) {
    const candidate = `${result} · ${detail}`;
    if (candidate.length > width) continue;
    result = candidate;
  }
  return truncateMiddle(result, width);
}

function lineRange(call: Extract<HudActivityCall, { type: "read_file_range" }>): string | undefined {
  if (call.startLine && call.lineCount) return `lines ${call.startLine}–${call.startLine + call.lineCount - 1}`;
  if (call.startLine) return `from line ${call.startLine}`;
  if (call.lineCount) return `first ${call.lineCount} lines`;
  return undefined;
}

export function activityCallByteLength(call: HudActivityCall): number {
  return Buffer.byteLength(JSON.stringify(call), "utf8");
}

export function formatActivityCall(call: HudActivityCall, mode: HudActivityMode, width: number): string {
  const detailed = mode === "detailed";
  const pathWidth = detailed ? Math.max(1, width - 5) : width;
  switch (call.type) {
    case "read_file":
    case "view_image":
      return detailed ? `path ${fitPath(call.path, pathWidth, true)}` : fitPath(call.path, width);
    case "list_files": {
      const target = detailed
        ? `path ${fitPath(call.path ?? ".", pathWidth, true)}`
        : fitPath(call.path ?? ".", width);
      const details = detailed
        ? [
            ...(call.recursive ? ["recursive"] : []),
            ...(call.limit ? [`limit ${call.limit}`] : []),
            ...(call.cursor ? [`after ${truncateMiddle(quote(call.cursor), 28)}`] : []),
            ...(call.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS ? [] : [`timeout ${call.timeoutMs} ms`]),
          ]
        : call.recursive ? ["recursive"] : [];
      return appendDetails(target, details, width);
    }
    case "search_text": {
      const queryPrefix = detailed ? "query " : "";
      const connector = detailed ? " in path " : " in ";
      const contentWidth = width - queryPrefix.length - connector.length;
      if (contentWidth < 6) {
        return `${queryPrefix}${fitToken(quote(call.query), Math.max(1, width - queryPrefix.length))}`;
      }
      let pathBudget = Math.max(3, Math.floor(contentWidth * 0.42));
      let path = fitPath(call.path ?? ".", pathBudget, detailed);
      let queryWidth = contentWidth - path.length;
      if (queryWidth < 3) {
        pathBudget = Math.max(3, pathBudget - (3 - queryWidth));
        path = fitPath(call.path ?? ".", pathBudget, detailed);
        queryWidth = contentWidth - path.length;
      }
      const query = fitToken(quote(call.query), Math.max(1, queryWidth));
      const target = `${queryPrefix}${query}${connector}${path}`;
      const details = detailed
        ? [
            ...(call.matchMode === "regex" ? ["regex"] : []),
            ...(call.caseSensitive ? ["case-sensitive"] : []),
            ...(call.extensions?.length ? [`extensions ${call.extensions.join(", ")}`] : []),
            ...(call.includeGlobs?.length ? [`${call.includeGlobs.length} include ${call.includeGlobs.length === 1 ? "glob" : "globs"}`] : []),
            ...(call.excludeGlobs?.length ? [`${call.excludeGlobs.length} exclude ${call.excludeGlobs.length === 1 ? "glob" : "globs"}`] : []),
            ...(call.maxResults ? [`limit ${call.maxResults}`] : []),
            ...(call.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS ? [] : [`timeout ${call.timeoutMs} ms`]),
          ]
        : [];
      return appendDetails(target, details, width);
    }
    case "read_file_range": {
      const range = lineRange(call);
      const rangeWidth = range ? range.length + 3 : 0;
      const target = detailed
        ? `path ${fitPath(call.path, Math.max(8, pathWidth - rangeWidth), true)}`
        : fitPath(call.path, Math.max(8, width - rangeWidth));
      return appendDetails(target, [range, detailed && call.timeoutMs !== MAX_STRUCTURED_READ_TIMEOUT_MS ? `timeout ${call.timeoutMs} ms` : undefined].filter((value): value is string => Boolean(value)), width);
    }
    case "write_file": {
      const target = detailed ? `path ${fitPath(call.path, pathWidth, true)}` : fitPath(call.path, width);
      return appendDetails(target, [formatByteCount(call.contentBytes), ...(call.expectedSha256 ? ["guarded"] : [])], width);
    }
    case "edit_file": {
      const target = detailed ? `path ${fitPath(call.path, pathWidth, true)}` : fitPath(call.path, width);
      const editLabel = `${call.editCount} ${call.editCount === 1 ? "edit" : "edits"}`;
      return appendDetails(target, [editLabel, ...(call.expectedSha256 ? ["guarded"] : []), ...(detailed ? [formatByteCount(call.editBytes)] : [])], width);
    }
    case "make_directory":
    case "delete_path": {
      const target = detailed ? `path ${fitPath(call.path, pathWidth, true)}` : fitPath(call.path, width);
      return appendDetails(target, call.recursive ? ["recursive"] : [], width);
    }
    case "move_path": {
      const leftWidth = Math.max(4, Math.floor((width - 3) / 2));
      const rightWidth = Math.max(4, width - leftWidth - 3);
      return `${fitPath(call.source, leftWidth, detailed)} → ${fitPath(call.destination, rightWidth, detailed)}`;
    }
    case "run_command": {
      const target = call.argv
        ? detailed ? detailedArgv(call.argv, width) : compactArgv(call.argv, width)
        : detailed
          ? `shell ${truncateMiddle(quote(call.shellCommand ?? ""), Math.max(1, width - 6))}`
          : truncateMiddle(escapeActivityText(call.shellCommand ?? ""), width);
      if (!detailed) return target;
      return appendDetails(target, [
        ...(call.stdinBytes === undefined ? [] : [`stdin ${formatByteCount(call.stdinBytes)}`]),
        ...(call.timeoutMs === DEFAULT_COMMAND_TIMEOUT_MS ? [] : [`timeout ${call.timeoutMs} ms`]),
        ...(call.waitMs === undefined || call.waitMs === DEFAULT_COMMAND_FAST_WAIT_MS ? [] : [`wait ${call.waitMs} ms`]),
      ], width);
    }
    case "get_command": {
      const target = `command ${detailed ? call.commandId : shortId(call.commandId)}`;
      return detailed
        ? appendDetails(target, [
            ...(call.waitMs ? [`wait ${call.waitMs} ms`] : []),
            ...(call.afterSequence === undefined ? [] : [`after sequence ${call.afterSequence}`]),
          ], width)
        : truncateMiddle(target, width);
    }
    case "read_command_output": {
      const target = `command ${detailed ? call.commandId : shortId(call.commandId)} ${call.stream}`;
      return detailed
        ? appendDetails(target, [
            ...(call.offset === undefined ? [] : [`offset ${call.offset}`]),
            ...(call.maxBytes === undefined ? [] : [`max ${call.maxBytes} bytes`]),
          ], width)
        : truncateMiddle(target, width);
    }
    case "cancel_command":
      return truncateMiddle(`command ${detailed ? call.commandId : shortId(call.commandId)}`, width);
  }
}

function listValue(values: string[]): string {
  return `[${values.map(quote).join(", ")}]`;
}

export function activityCallDetailFields(call: HudActivityCall): HudActivityDetailField[] {
  switch (call.type) {
    case "read_file":
    case "view_image":
      return [{ label: "path", value: quote(call.path) }];
    case "list_files":
      return [
        { label: "path", value: call.path === undefined ? '"."' : quote(call.path) },
        ...(call.recursive ? [{ label: "recursive", value: "true" }] : []),
        ...(call.cursor === undefined ? [] : [{ label: "cursor", value: quote(call.cursor) }]),
        ...(call.limit === undefined ? [] : [{ label: "limit", value: String(call.limit) }]),
        ...(call.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS ? [] : [{ label: "timeoutMs", value: String(call.timeoutMs) }]),
      ];
    case "search_text":
      return [
        { label: "query", value: quote(call.query) },
        { label: "path", value: call.path === undefined ? '"."' : quote(call.path) },
        ...(call.matchMode === "regex" ? [{ label: "matchMode", value: "regex" }] : []),
        ...(call.caseSensitive ? [{ label: "caseSensitive", value: "true" }] : []),
        ...(call.maxResults === undefined ? [] : [{ label: "maxResults", value: String(call.maxResults) }]),
        ...(call.extensions === undefined ? [] : [{ label: "extensions", value: listValue(call.extensions) }]),
        ...(call.includeGlobs === undefined ? [] : [{ label: "includeGlobs", value: listValue(call.includeGlobs) }]),
        ...(call.excludeGlobs === undefined ? [] : [{ label: "excludeGlobs", value: listValue(call.excludeGlobs) }]),
        ...(call.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS ? [] : [{ label: "timeoutMs", value: String(call.timeoutMs) }]),
      ];
    case "read_file_range":
      return [
        { label: "path", value: quote(call.path) },
        ...(call.startLine === undefined ? [] : [{ label: "startLine", value: String(call.startLine) }]),
        ...(call.lineCount === undefined ? [] : [{ label: "lineCount", value: String(call.lineCount) }]),
        ...(call.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS ? [] : [{ label: "timeoutMs", value: String(call.timeoutMs) }]),
      ];
    case "write_file":
      return [
        { label: "path", value: quote(call.path) },
        { label: "content", value: `${formatByteCount(call.contentBytes)} · content not retained in Activity` },
        ...(call.expectedSha256 === undefined ? [] : [{ label: "expectedSha256", value: call.expectedSha256 }]),
      ];
    case "edit_file":
      return [
        { label: "path", value: quote(call.path) },
        { label: "edits", value: `${call.editCount} ${call.editCount === 1 ? "edit" : "edits"} · ${formatByteCount(call.editBytes)} · text not retained in Activity` },
        ...(call.expectedSha256 === undefined ? [] : [{ label: "expectedSha256", value: call.expectedSha256 }]),
      ];
    case "make_directory":
    case "delete_path":
      return [
        { label: "path", value: quote(call.path) },
        ...(call.recursive ? [{ label: "recursive", value: "true" }] : []),
      ];
    case "move_path":
      return [
        { label: "source", value: quote(call.source) },
        { label: "destination", value: quote(call.destination) },
      ];
    case "run_command":
      return [
        ...(call.argv === undefined ? [] : [{ label: "argv", value: listValue(call.argv) }]),
        ...(call.shellCommand === undefined ? [] : [{ label: "shellCommand", value: quote(call.shellCommand) }]),
        ...(call.stdinBytes === undefined ? [] : [{ label: "stdin", value: `${formatByteCount(call.stdinBytes)} · content not retained in Activity` }]),
        ...(call.timeoutMs === DEFAULT_COMMAND_TIMEOUT_MS ? [] : [{ label: "timeoutMs", value: String(call.timeoutMs) }]),
        ...(call.waitMs === undefined || call.waitMs === DEFAULT_COMMAND_FAST_WAIT_MS ? [] : [{ label: "waitMs", value: String(call.waitMs) }]),
      ];
    case "get_command":
      return [
        { label: "commandId", value: call.commandId },
        ...(call.waitMs === undefined ? [] : [{ label: "waitMs", value: String(call.waitMs) }]),
        ...(call.afterSequence === undefined ? [] : [{ label: "afterSequence", value: String(call.afterSequence) }]),
      ];
    case "read_command_output":
      return [
        { label: "commandId", value: call.commandId },
        { label: "stream", value: call.stream },
        ...(call.offset === undefined || call.offset === 0 ? [] : [{ label: "offset", value: String(call.offset) }]),
        ...(call.maxBytes === undefined || call.maxBytes === DEFAULT_COMMAND_OUTPUT_RANGE_BYTES ? [] : [{ label: "maxBytes", value: String(call.maxBytes) }]),
      ];
    case "cancel_command":
      return [{ label: "commandId", value: call.commandId }];
  }
}

export function activityToolTitle(type: HudActivityCall["type"]): string {
  return type.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}
