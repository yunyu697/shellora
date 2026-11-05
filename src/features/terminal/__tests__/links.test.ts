// T10 链接识别：纯文本 URL、file:line、标点不吞、OSC 8 优先（内核行为）说明见验收表。

import { describe, expect, it } from "vitest";

import { findLinks, linkOpenTarget } from "../links";

describe("T10 链接识别", () => {
  it("URL 不吞结尾标点，括号按配对裁剪", () => {
    const line = "见 https://example.com/x, 或 (https://example.com/y).";
    const links = findLinks(line);
    expect(links.map((l) => l.text)).toEqual(["https://example.com/x", "https://example.com/y"]);
  });

  it("file:line 与 file:line:col 均可识别", () => {
    const line = "src/main.rs:42 and ./lib/mod.ts:12:3";
    const links = findLinks(line);
    expect(links.map((l) => [l.kind, l.text])).toEqual([
      ["file", "src/main.rs:42"],
      ["file", "./lib/mod.ts:12:3"],
    ]);
    expect(linkOpenTarget(links[0])).toEqual({ kind: "file", target: "src/main.rs", line: 42 });
    expect(linkOpenTarget(links[1]).line).toBe(12);
  });

  it("URL 与 file 重叠时优先 URL，不重复命中", () => {
    const line = "https://host/a.rs:42";
    const links = findLinks(line);
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe("url");
  });

  it("起始列正确，hover/点击范围可由 provider 直接使用", () => {
    const line = "xx https://example.com/z yy";
    const link = findLinks(line)[0];
    expect(line.slice(link.start, link.end)).toBe("https://example.com/z");
  });
});
