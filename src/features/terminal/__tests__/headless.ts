// 测试公共夹具：headless xterm 的写入/取行/cell 读取。
import { Terminal } from "@xterm/headless";

export interface TermOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

export function createTerm(options?: TermOptions): Terminal {
  return new Terminal({
    cols: options?.cols ?? 80,
    rows: options?.rows ?? 24,
    scrollback: options?.scrollback ?? 1000,
    allowProposedApi: true,
  });
}

export function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

export function lineText(term: Terminal, y: number, trimRight = false): string {
  return term.buffer.active.getLine(y)?.translateToString(trimRight) ?? "";
}

export function cellAt(term: Terminal, x: number, y: number) {
  return term.buffer.active.getLine(y)?.getCell(x);
}
