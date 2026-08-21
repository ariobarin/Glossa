import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { render } from "ink";
import { HudScreen } from "./ui-hud.js";
import type { HudState } from "./ui-hud-model.js";

class TestOutput extends EventEmitter {
  frames: string[] = [];

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }

  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

class TestInput extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

export function renderHud(
  state: HudState,
  width = 80,
  color = true,
  height = 24,
  now = Date.now(),
): string {
  const stdout = new TestOutput(width, height);
  const stderr = new TestOutput(width, height);
  const stdin = new TestInput();
  const instance = render(
    <HudScreen state={state} columns={width} rows={height} color={color} now={now} />,
    {
      stdout: stdout as unknown as WriteStream,
      stderr: stderr as unknown as WriteStream,
      stdin: stdin as unknown as ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  const output = stdout.frames.at(-1) ?? "";
  instance.unmount();
  instance.cleanup();
  return color ? output : stripVTControlCharacters(output);
}
