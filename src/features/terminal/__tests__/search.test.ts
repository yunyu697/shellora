// T11 搜索：增量高亮、结果计数、前后跳转、大小写开关、不改变缓冲区内容。

import { describe, expect, it } from "vitest";
import type { ISearchOptions } from "@xterm/addon-search";

import { createTerm, lineText, write } from "./headless";

interface SearchResultEvent {
  resultIndex: number;
  resultCount: number;
}

interface SearchAddonLike {
  findNext(term: string, options?: ISearchOptions): boolean;
  findPrevious(term: string, options?: ISearchOptions): boolean;
  clearDecorations(): void;
  onDidChangeResults(cb: (e: SearchResultEvent) => void): { dispose(): void };
}

const DECORATIONS = {
  matchBackground: "#31435a",
  matchBorder: "#5a7a9a",
  matchOverviewRuler: "#5a7a9a",
  activeMatchBackground: "#e5c07b",
  activeMatchBorder: "#e5c07b",
  activeMatchColorOverviewRuler: "#e5c07b",
};

async function setup() {
  // addon-search 的 UMD 包引用 self；Node 测试环境下补一个别名。
  (globalThis as unknown as { self: typeof globalThis }).self ??= globalThis;
  const { SearchAddon } = await import("@xterm/addon-search");
  const term = createTerm({ cols: 80, rows: 20 });
  // headless 终端缺少选区政府/装饰器渲染 API；搜索计数与跳转只需最小桩。
  const patched = term as unknown as Record<string, unknown>;
  const disposable = () => ({ dispose: () => undefined });
  patched.getSelectionPosition = () => undefined;
  patched.getSelection = () => "";
  patched.select = () => undefined;
  patched.clearSelection = () => undefined;
  patched.registerMarker = () => ({
    line: 0,
    col: 0,
    isDisposed: false,
    dispose: () => undefined,
  });
  patched.registerDecoration = () => ({
    marker: { line: 0, isDisposed: false, dispose: () => undefined },
    dispose: () => undefined,
    onRender: disposable,
    onDispose: disposable,
    isDisposed: false,
  });
  const search = new SearchAddon() as unknown as SearchAddonLike;
  term.loadAddon(search as never);
  await write(term, "error one\r\nsecond error\r\nERROR upper\r\n");
  const events: SearchResultEvent[] = [];
  search.onDidChangeResults((e) => events.push(e));
  return { term, search, events };
}

describe("T11 搜索", () => {
  it("默认不区分大小写时计数为 3", async () => {
    const { term, search, events } = await setup();
    search.findNext("error", { caseSensitive: false, decorations: DECORATIONS });
    const last = events.at(-1);
    expect(last?.resultCount).toBe(3);
    expect(last?.resultIndex ?? -1).toBeGreaterThanOrEqual(0);
    expect(last?.resultIndex ?? -1).toBeLessThan(3);
    term.dispose();
  });

  it("区分大小写时只命中 2 条小写 error", async () => {
    const { term, search, events } = await setup();
    search.findNext("error", { caseSensitive: true, decorations: DECORATIONS });
    expect(events.at(-1)?.resultCount).toBe(2);
    term.dispose();
  });

  it("findPrevious 循环不越界（索引始终在 [0,count)）", async () => {
    const { term, search, events } = await setup();
    search.findNext("error", { caseSensitive: true, decorations: DECORATIONS });
    for (let i = 0; i < 5; i++) {
      search.findPrevious("error", { caseSensitive: true, decorations: DECORATIONS });
      const e = events.at(-1)!;
      expect(e.resultIndex).toBeGreaterThanOrEqual(0);
      expect(e.resultIndex).toBeLessThan(e.resultCount);
    }
    term.dispose();
  });

  it("搜索结果不改变缓冲区文本", async () => {
    const { term, search } = await setup();
    const before = [0, 1, 2].map((y) => lineText(term, y, true));
    search.findNext("error", { caseSensitive: true, decorations: DECORATIONS });
    search.clearDecorations();
    const after = [0, 1, 2].map((y) => lineText(term, y, true));
    expect(after).toEqual(before);
    term.dispose();
  });
});
