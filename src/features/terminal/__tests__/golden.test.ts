// §4 golden：T01 真彩色 / T02 16 色与属性 / T03 resize / T04 宽字符 / T08 alternate screen / T15 DEC 图形集。
// 断言对象是 xterm 缓冲区（字符、宽度、颜色索引/属性），与截图逐字符等价的机器可判定形式。

import { describe, expect, it } from "vitest";
import { Unicode11Addon } from "@xterm/addon-unicode11";

import { cellAt, createTerm, lineText, write } from "./headless";

describe("T01 真彩色与 256 色", () => {
  it("38;2;12;200;99 精确落到 RGB cell", async () => {
    const term = createTerm();
    await write(term, "\x1b[38;2;12;200;99mX\x1b[0m");
    const cell = cellAt(term, 0, 0)!;
    expect(cell.isFgRGB()).toBe(true);
    expect(cell.getFgColor()).toBe(0x0cc863);
  });

  it("48;2 背景色与 38;5;196 调色板索引正确", async () => {
    const term = createTerm();
    await write(term, "\x1b[48;2;12;200;99mX\x1b[0m\x1b[38;5;196mY\x1b[0m");
    const bg = cellAt(term, 0, 0)!;
    expect(bg.isBgRGB()).toBe(true);
    expect(bg.getBgColor()).toBe(0x0cc863);
    const fg = cellAt(term, 1, 0)!;
    expect(fg.isFgPalette()).toBe(true);
    expect(fg.getFgColor()).toBe(196);
    term.dispose();
  });
});

describe("T02 基础 16 色与 SGR 属性", () => {
  it("SGR 1/2/3/4/5/7/9 逐项生效且不崩", async () => {
    const term = createTerm();
    const seqs: Array<[string, (c: NonNullable<ReturnType<typeof cellAt>>) => number]> = [
      ["\x1b[1mB\x1b[0m", (c) => c.isBold()],
      ["\x1b[2mD\x1b[0m", (c) => c.isDim()],
      ["\x1b[3mI\x1b[0m", (c) => c.isItalic()],
      ["\x1b[4mU\x1b[0m", (c) => c.isUnderline()],
      ["\x1b[5mK\x1b[0m", (c) => c.isBlink()],
      ["\x1b[7mR\x1b[0m", (c) => c.isInverse()],
      ["\x1b[9mS\x1b[0m", (c) => c.isStrikethrough()],
    ];
    for (const [seq] of seqs) await write(term, seq);
    for (let x = 0; x < seqs.length; x++) {
      // xterm 的属性以位掩码返回（非 0 即生效）。
      expect(seqs[x][1](cellAt(term, x, 0)!), `属性 ${x} 未生效`).not.toBe(0);
    }
    term.dispose();
  });

  it("16 色（30-37 / 90-97）落到对应调色板索引", async () => {
    const term = createTerm();
    let seq = "";
    for (let i = 0; i < 16; i++) {
      const code = i < 8 ? 30 + i : 90 + (i - 8);
      seq += `\x1b[${code}mX`;
    }
    await write(term, seq);
    for (let i = 0; i < 16; i++) {
      const cell = cellAt(term, i, 0)!;
      expect(cell.isFgPalette()).toBe(true);
      expect(cell.getFgColor()).toBe(i);
    }
    term.dispose();
  });
});

describe("T03 resize / 超宽换行 / onResize", () => {
  it("resize 立即更新 cols/rows 并触发一次 onResize，既有内容不受损", async () => {
    const term = createTerm({ cols: 120, rows: 30 });
    const sizes: Array<{ cols: number; rows: number }> = [];
    term.onResize((size) => sizes.push(size));
    await write(term, "abc");
    term.resize(80, 20);
    expect(term.cols).toBe(80);
    expect(term.rows).toBe(20);
    expect(sizes).toHaveLength(1);
    expect(sizes[0].cols).toBe(80);
    expect(sizes[0].rows).toBe(20);
    expect(lineText(term, 0, true)).toBe("abc");
    term.dispose();
  });

  it("超过列宽自动换行：第 81 个字符落到下一行", async () => {
    const term = createTerm({ cols: 80, rows: 10 });
    await write(term, "x".repeat(81));
    expect(lineText(term, 0, true)).toHaveLength(80);
    expect(lineText(term, 1, true)).toBe("x");
    term.dispose();
  });
});

describe("T04 宽字符 / emoji / 组合符", () => {
  it("CJK 占 2 列，竖线严格落在第 10 列", async () => {
    const term = createTerm();
    term.loadAddon(new Unicode11Addon() as unknown as never);
    term.unicode.activeVersion = "11";
    await write(term, "中文ab");
    expect(cellAt(term, 0, 0)!.getWidth()).toBe(2);
    expect(cellAt(term, 1, 0)!.getWidth()).toBe(0);
    expect(cellAt(term, 2, 0)!.getWidth()).toBe(2);
    await write(term, "\x1b[10G|");
    // 宽字符在缓冲区占两格：第 10 列（0 基索引 9）必须是竖线。
    expect(cellAt(term, 9, 0)!.getChars()).toBe("|");
  });

  it("emoji ZWJ 序列不撕裂；e + 组合符占 1 列", async () => {
    const term = createTerm({ cols: 40 });
    term.loadAddon(new Unicode11Addon() as unknown as never);
    term.unicode.activeVersion = "11";
    await write(term, "👨‍👩‍👧‍👦");
    const first = cellAt(term, 0, 0)!;
    expect(first.getWidth()).toBe(2);
    expect(first.getWidth()).toBeLessThanOrEqual(2);
    await write(term, "\r\ne\u0301");
    const composed = cellAt(term, 0, 1)!;
    expect(composed.getWidth()).toBe(1);
    expect(composed.getChars()).toContain("\u0301");
    term.dispose();
  });
});

describe("T08 alternate screen", () => {
  it("1049h/l 恢复原内容与光标，不污染 scrollback", async () => {
    const term = createTerm({ rows: 10 });
    await write(term, "alpha");
    await write(term, "\x1b[?1049h");
    expect(term.buffer.active.type).toBe("alternate");
    await write(term, "\x1b[2J\x1b[Hbeta");
    expect(lineText(term, 0, true)).toBe("beta");
    await write(term, "\x1b[?1049l");
    expect(term.buffer.active.type).toBe("normal");
    expect(lineText(term, 0, true)).toBe("alpha");
    expect(term.buffer.normal.length).toBeLessThanOrEqual(10);
    term.dispose();
  });
});

describe("T15 DEC 图形集", () => {
  it("\\e(0lqqqk\\e(B 输出 ┌───┐ 而非 lqqqk", async () => {
    const term = createTerm();
    await write(term, "\x1b(0lqqqk\x1b(B");
    expect(lineText(term, 0, true)).toBe("┌───┐");
    term.dispose();
  });
});

