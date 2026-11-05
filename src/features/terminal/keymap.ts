// 键位映射表：mac 的 Option 视作 Meta；Windows/Linux 的 Alt 保持 ESC 前缀语义。
// 纯函数，便于单测；useTerminal 只负责把结果投递到 IPC。

export type KeyPlatform = "mac" | "windows" | "linux";

export interface KeyLike {
  type?: string;
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export type KeyAction =
  | { kind: "passthrough" }
  | { kind: "send"; data: string }
  | { kind: "copy" }
  | { kind: "paste" };

export function detectPlatform(navPlatform: string): KeyPlatform {
  const p = navPlatform.toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "windows";
  return "linux";
}

/** Option/Meta 语义：单字符按键 → ESC 前缀；其余交给 xterm 默认处理。 */
function metaSequence(ev: KeyLike): string | null {
  if (ev.key.length !== 1) return null;
  return `\x1b${ev.key}`;
}

export function resolveKey(ev: KeyLike, platform: KeyPlatform): KeyAction {
  if (ev.type && ev.type !== "keydown") return { kind: "passthrough" };

  const ctrl = Boolean(ev.ctrlKey);
  const alt = Boolean(ev.altKey);
  const meta = Boolean(ev.metaKey);
  const shift = Boolean(ev.shiftKey);

  if (platform === "mac") {
    if (meta && !ctrl && !alt && ev.key.toLowerCase() === "c" && !shift) return { kind: "copy" };
    if (meta && !ctrl && !alt && ev.key.toLowerCase() === "v" && !shift) {
      // Cmd+V 仍让浏览器触发 paste 事件，由容器上的 paste 处理统一走确认流程。
      return { kind: "passthrough" };
    }
    // Option 作为 Meta：Alt+字符 → ESC+字符（不参与 Ctrl/Meta 组合）。
    if (alt && !ctrl && !meta) {
      const seq = metaSequence(ev);
      return seq ? { kind: "send", data: seq } : { kind: "passthrough" };
    }
    return { kind: "passthrough" };
  }

  // Windows / Linux：Alt 作为组合键前缀（Windows Terminal 默认行为）。
  if (ctrl && shift && ev.key.toLowerCase() === "c") return { kind: "copy" };
  if (ctrl && shift && ev.key.toLowerCase() === "v") return { kind: "paste" };
  if (alt && !ctrl && !meta) {
    const seq = metaSequence(ev);
    return seq ? { kind: "send", data: seq } : { kind: "passthrough" };
  }
  return { kind: "passthrough" };
}

/** 供 UI 提示用的快捷键名称。 */
export function copyShortcutLabel(platform: KeyPlatform): string {
  return platform === "mac" ? "⌘C" : "Ctrl+Shift+C";
}

export function pasteShortcutLabel(platform: KeyPlatform): string {
  return platform === "mac" ? "⌘V" : "Ctrl+Shift+V";
}
