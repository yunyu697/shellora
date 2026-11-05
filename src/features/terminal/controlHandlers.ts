// 把 OSC 7 / DECSCUSR 挂到 xterm parser 上；同一份代码既用于运行时，也用于 headless golden。

import { decscusrToCursorShape, parseOsc7, type CursorShape } from "./terminalControl";

interface Disposable {
  dispose(): void;
}

export interface ParserLike {
  registerOscHandler(ident: number, callback: (data: string) => boolean): Disposable;
  registerCsiHandler(
    id: { final: string; intermediates?: string; prefix?: string },
    callback: (params: (number | number[])[]) => boolean,
  ): Disposable;
}

export interface ControlHandlers {
  onCwd?: (cwd: string) => void;
  onCursorShape?: (shape: CursorShape) => void;
}

export function installControlHandlers(
  parser: ParserLike,
  handlers: ControlHandlers,
): Disposable {
  const disposables: Disposable[] = [];

  disposables.push(
    parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data);
      if (cwd) handlers.onCwd?.(cwd);
      return true;
    }),
  );

  disposables.push(
    parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      const raw = params[0];
      const param = Array.isArray(raw) ? raw[0] ?? 0 : raw ?? 0;
      const shape = decscusrToCursorShape(Number(param));
      if (shape) handlers.onCursorShape?.(shape);
      // 返回 false：让 xterm 内核继续执行默认的 DECSCUSR 处理。
      return false;
    }),
  );

  return {
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
