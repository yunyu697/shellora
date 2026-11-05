// 键位映射：mac Option=Meta；Windows/Linux Alt=ESC 前缀；复制/粘贴快捷键。

import { describe, expect, it } from "vitest";

import { detectPlatform, resolveKey } from "../keymap";

const base = { type: "keydown", key: "a" } as const;

describe("键位映射", () => {
  it("平台识别", () => {
    expect(detectPlatform("MacIntel")).toBe("mac");
    expect(detectPlatform("Win32")).toBe("windows");
    expect(detectPlatform("Linux x86_64")).toBe("linux");
  });

  it("macOS：Option+字符 → Meta 序列（ESC 前缀）", () => {
    expect(resolveKey({ ...base, altKey: true }, "mac")).toEqual({
      kind: "send",
      data: "\x1ba",
    });
    // Ctrl+Option 不抢占，交给 xterm（例如 Ctrl+Option+方向键按词移动）。
    expect(resolveKey({ ...base, altKey: true, ctrlKey: true }, "mac")).toEqual({
      kind: "passthrough",
    });
  });

  it("macOS：Cmd+C 复制、Cmd+V 交给 paste 事件", () => {
    expect(resolveKey({ ...base, key: "c", metaKey: true }, "mac")).toEqual({ kind: "copy" });
    expect(resolveKey({ ...base, key: "v", metaKey: true }, "mac")).toEqual({
      kind: "passthrough",
    });
  });

  it("Windows/Linux：Alt+字符 → ESC 前缀；Ctrl+Shift+C/V", () => {
    expect(resolveKey({ ...base, altKey: true }, "windows")).toEqual({
      kind: "send",
      data: "\x1ba",
    });
    expect(resolveKey({ ...base, key: "c", ctrlKey: true, shiftKey: true }, "windows")).toEqual({
      kind: "copy",
    });
    expect(resolveKey({ ...base, key: "v", ctrlKey: true, shiftKey: true }, "linux")).toEqual({
      kind: "paste",
    });
  });

  it("普通按键与 keyup 一律放行给 xterm", () => {
    expect(resolveKey(base, "linux")).toEqual({ kind: "passthrough" });
    expect(resolveKey({ ...base, type: "keyup" }, "mac")).toEqual({ kind: "passthrough" });
  });
});
