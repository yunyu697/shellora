// 终端控制序列的纯逻辑：OSC 7 cwd、DECSCUSR 光标形状、SGR 鼠标编码、焦点上报。
// golden/单测直接调用这里，运行时由 useTerminal 注册到 xterm parser。

export interface CursorShape {
  style: "block" | "underline" | "bar";
  blink: boolean;
}

/** T14：DECSCUSR `CSI Ps SP q` 参数映射；未知参数返回 null（保持原状）。 */
export function decscusrToCursorShape(param: number): CursorShape | null {
  switch (param) {
    case 0:
    case 1:
      return { style: "block", blink: true };
    case 2:
      return { style: "block", blink: false };
    case 3:
      return { style: "underline", blink: true };
    case 4:
      return { style: "underline", blink: false };
    case 5:
      return { style: "bar", blink: true };
    case 6:
      return { style: "bar", blink: false };
    default:
      return null;
  }
}

/** T16：OSC 7 `file://<host>/<path>` 取 cwd；非法或非绝对路径返回 null。 */
export function parseOsc7(data: string): string | null {
  if (!data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  let path = rest.slice(slash);
  const hash = path.indexOf("#");
  if (hash >= 0) path = path.slice(0, hash);
  if (!path.startsWith("/")) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export interface SgrMouseInput {
  /** 0=左键 1=中键 2=右键 64=滚轮上 65=滚轮下 */
  button: number;
  /** 0 基列/行（xterm 内部坐标） */
  col: number;
  row: number;
  pressed: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/** T06：1006(SGR) 鼠标上报编码。坐标对外 1 基。 */
export function encodeSgrMouse(input: SgrMouseInput): string {
  let code = input.button;
  if (input.shift) code += 4;
  if (input.alt) code += 8;
  if (input.ctrl) code += 16;
  const x = input.col + 1;
  const y = input.row + 1;
  return `\x1b[<${code};${x};${y}${input.pressed ? "M" : "m"}`;
}

/** T16：1004 模式下的 FocusIn/FocusOut 上报。 */
export function focusSequence(focused: boolean): string {
  return focused ? "\x1b[I" : "\x1b[O";
}

/** T07：alternate screen 下滚轮转换为方向键（normal screen 仍走 scrollback）。 */
export function wheelToArrow(up: boolean, applicationCursorKeys: boolean): string {
  if (applicationCursorKeys) return up ? "\x1bOA" : "\x1bOB";
  return up ? "\x1b[A" : "\x1b[B";
}

/** 把 DOM 按键事件里的鼠标按键映射成 SGR button 码；未知返回 null。 */
export function domButtonToSgr(button: number, wheelUp?: boolean): number | null {
  if (wheelUp !== undefined) return wheelUp ? 64 : 65;
  if (button === 0) return 0;
  if (button === 1) return 1;
  if (button === 2) return 2;
  return null;
}
