// T09 bracketed paste / T12 选中复制规范化 / T13 多行粘贴确认（含 500 行脚本）。

import { describe, expect, it } from "vitest";

import {
  analyzePaste,
  normalizeSelection,
  summarizePasteLineCount,
  wrapBracketedPaste,
} from "../pasteGuard";
import { createTerm, write } from "./headless";

describe("T09 bracketed paste", () => {
  it("2004h 时模式开启，包装为 ESC[200~…ESC[201~", async () => {
    const term = createTerm();
    await write(term, "\x1b[?2004h");
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(wrapBracketedPaste("a\nb", term.modes.bracketedPasteMode)).toBe(
      "\x1b[200~a\nb\x1b[201~",
    );
    await write(term, "\x1b[?2004l");
    expect(term.modes.bracketedPasteMode).toBe(false);
    expect(wrapBracketedPaste("a\nb", term.modes.bracketedPasteMode)).toBe("a\nb");
    term.dispose();
  });
});

describe("T12 选中复制", () => {
  it("规范化去掉 \\r 与末尾换行，内容逐字节一致", () => {
    expect(normalizeSelection("a\r\nb\r\n")).toBe("a\nb");
    expect(normalizeSelection("a\nb")).toBe("a\nb");
    expect(normalizeSelection("")).toBe("");
    expect(normalizeSelection("x\r\ny")).toBe("x\ny");
  });

  it("双击选词由 xterm 断词（分隔符边界），复制不带行尾", () => {
    // 该层是 xterm 内置行为；这里固化"复制结果"的边界约定。
    expect(normalizeSelection("foo_bar\n")).toBe("foo_bar");
  });
});

describe("T13 多行/500 行粘贴确认", () => {
  it("3 行命令触发确认，文案含行数与回车风险", () => {
    const text = "echo one\necho two\necho three\n";
    const a = analyzePaste(text);
    expect(a.needsConfirm).toBe(true);
    expect(a.lineCount).toBe(3);
    expect(a.summary).toContain("3 行");
    expect(a.summary).toContain("含回车");
  });

  it("500 行脚本行数准确，取消后不产生输入（UI 侧由返回 null 保证）", () => {
    const script = Array.from({ length: 500 }, (_, i) => `echo line${i + 1}`).join("\n") + "\n";
    const a = analyzePaste(script);
    expect(a.lineCount).toBe(500);
    expect(a.needsConfirm).toBe(true);
    expect(a.summary).toContain("500 行");
  });

  it("单行无控制字符默认直接发送", () => {
    const a = analyzePaste("ls -la");
    expect(a.needsConfirm).toBe(false);
    expect(a.lineCount).toBe(1);
    expect(a.summary).toContain("1 行");
  });

  it("confirm_always 时单行也确认；控制字符也确认", () => {
    expect(analyzePaste("ls", { confirmAlways: true }).needsConfirm).toBe(true);
    const ctrl = analyzePaste("a\x07b");
    expect(ctrl.hasControlChar).toBe(true);
    expect(ctrl.needsConfirm).toBe(true);
    expect(ctrl.summary).toContain("控制字符");
  });

  it("行数统计忽略末尾换行但保留空行", () => {
    expect(summarizePasteLineCount("a\nb\n")).toBe(2);
    expect(summarizePasteLineCount("a\n\nb")).toBe(3);
    expect(summarizePasteLineCount("")).toBe(0);
  });
});
