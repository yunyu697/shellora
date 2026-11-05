// T14 光标形状（DECSCUSR）与 T16 标题 / OSC 7 / 焦点 / 鼠标模式。
// 形状映射与渲染分离：映射在本用例断言，像素形状由三平台手工截图（见 docs/qa/m5-acceptance.md）。

import { describe, expect, it } from "vitest";

import { installControlHandlers, type ParserLike } from "../controlHandlers";
import { encodeSgrMouse, focusSequence, wheelToArrow } from "../terminalControl";
import { createTerm, write } from "./headless";

describe("T14 DECSCUSR", () => {
  it("\\e[1 q … \\e[6 q 映射为 block/underline/bar 与闪烁位", async () => {
    const term = createTerm();
    const shapes: Array<{ style: string; blink: boolean }> = [];
    const control = installControlHandlers(term.parser as unknown as ParserLike, {
      onCursorShape: (shape) => shapes.push(shape),
    });
    for (let i = 1; i <= 6; i++) await write(term, `\x1b[${i} q`);
    expect(shapes).toEqual([
      { style: "block", blink: true },
      { style: "block", blink: false },
      { style: "underline", blink: true },
      { style: "underline", blink: false },
      { style: "bar", blink: true },
      { style: "bar", blink: false },
    ]);
    // 未知参数（7）不产生事件，也不影响后续。
    await write(term, "\x1b[7 q");
    expect(shapes).toHaveLength(6);
    control.dispose();
    term.dispose();
  });
});

describe("T16 标题 / OSC 7 / 焦点 / 鼠标模式", () => {
  it("OSC 0 与 OSC 2 更新标题", async () => {
    const term = createTerm();
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    await write(term, "\x1b]0;demo\x07");
    await write(term, "\x1b]2;demo-2\x07");
    expect(titles).toEqual(["demo", "demo-2"]);
    term.dispose();
  });

  it("OSC 7 解析 file://host/tmp/a%20b 为绝对路径", async () => {
    const term = createTerm();
    const cwds: string[] = [];
    const control = installControlHandlers(term.parser as unknown as ParserLike, {
      onCwd: (cwd) => cwds.push(cwd),
    });
    await write(term, "\x1b]7;file://fixture/tmp/a%20b\x07");
    await write(term, "\x1b]7;file:///home/alice\x07");
    expect(cwds).toEqual(["/tmp/a b", "/home/alice"]);
    control.dispose();
    term.dispose();
  });

  it("1004h 开启 focus 上报模式；1004l 关闭", async () => {
    const term = createTerm();
    await write(term, "\x1b[?1004h");
    expect(term.modes.sendFocusMode).toBe(true);
    await write(term, "\x1b[?1004l");
    expect(term.modes.sendFocusMode).toBe(false);
    expect(focusSequence(true)).toBe("\x1b[I");
    expect(focusSequence(false)).toBe("\x1b[O");
    term.dispose();
  });

  it("1000/1002/1003 鼠标模式切换，1000l 归零", async () => {
    const term = createTerm();
    await write(term, "\x1b[?1000h\x1b[?1006h");
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    await write(term, "\x1b[?1000l\x1b[?1002h");
    expect(term.modes.mouseTrackingMode).toBe("drag");
    await write(term, "\x1b[?1002l\x1b[?1003h");
    expect(term.modes.mouseTrackingMode).toBe("any");
    await write(term, "\x1b[?1003l");
    expect(term.modes.mouseTrackingMode).toBe("none");
    term.dispose();
  });
});

describe("T06 SGR 鼠标编码", () => {
  it("左键按/松、拖动、滚轮与修饰键", () => {
    expect(encodeSgrMouse({ button: 0, col: 10, row: 5, pressed: true })).toBe("\x1b[<0;11;6M");
    expect(encodeSgrMouse({ button: 0, col: 10, row: 5, pressed: false })).toBe("\x1b[<0;11;6m");
    expect(
      encodeSgrMouse({ button: 32, col: 3, row: 2, pressed: true, ctrl: true }),
    ).toBe("\x1b[<48;4;3M");
    expect(encodeSgrMouse({ button: 64, col: 0, row: 0, pressed: true })).toBe("\x1b[<64;1;1M");
    expect(encodeSgrMouse({ button: 65, col: 0, row: 0, pressed: true })).toBe("\x1b[<65;1;1M");
  });
});

describe("T07 滚轮在 alternate screen 转方向键", () => {
  it("普通/应用光标键两种序列", () => {
    expect(wheelToArrow(true, false)).toBe("\x1b[A");
    expect(wheelToArrow(false, false)).toBe("\x1b[B");
    expect(wheelToArrow(true, true)).toBe("\x1bOA");
    expect(wheelToArrow(false, true)).toBe("\x1bOB");
  });
});
