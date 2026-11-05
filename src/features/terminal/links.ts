// T10：链接识别（纯文本 URL + file:line；OSC 8 由 xterm 内核直接处理并优先）。
// 链接末尾的标点（.,;:!? 与不配对的括号）不并入目标，避免 Ctrl+点击打开错误地址。

export type LinkKind = "url" | "file";

export interface LinkRange {
  /** 起始列（0 基，含） */
  start: number;
  /** 结束列（0 基，不含） */
  end: number;
  text: string;
  kind: LinkKind;
}

const URL_RE = /(?:https?|ftp):\/\/[^\s<>"'`]+/g;
const FILE_RE =
  /(?:[A-Za-z]:\\|\.{1,2}\/)?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.([A-Za-z0-9]+):(\d+)(?::(\d+))?/g;

const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "。", "，", "；", "：", "！", "？"]);

function trimUrlEnd(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (TRAILING_PUNCT.has(ch)) {
      end -= 1;
      continue;
    }
    break;
  }
  // 不配对的右括号视为句子标点，配对时保留。
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (end > 0 && pairs[raw[end - 1]]) {
    const close = raw[end - 1];
    const open = pairs[close];
    const body = raw.slice(0, end);
    const opens = body.split(open).length - 1;
    const closes = body.split(close).length - 1;
    if (closes > opens) end -= 1;
    else break;
  }
  return raw.slice(0, end);
}

export function findLinks(line: string): LinkRange[] {
  const out: LinkRange[] = [];
  const taken: Array<[number, number]> = [];

  for (const m of line.matchAll(URL_RE)) {
    const raw = m[0];
    const text = trimUrlEnd(raw);
    if (!text || text.length < "http://a".length) continue;
    const start = m.index ?? 0;
    out.push({ start, end: start + text.length, text, kind: "url" });
    taken.push([start, start + text.length]);
  }

  for (const m of line.matchAll(FILE_RE)) {
    const text = m[0];
    const start = m.index ?? 0;
    const end = start + text.length;
    if (taken.some(([s, e]) => start < e && end > s)) continue;
    out.push({ start, end, text, kind: "file" });
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Ctrl/Cmd+点击时的打开目标：file:line 交给编辑器，其余交给浏览器。 */
export function linkOpenTarget(link: LinkRange): { kind: LinkKind; target: string; line?: number } {
  if (link.kind === "url") return { kind: "url", target: link.text };
  const m = link.text.match(/:(\d+)(?::(\d+))?\s*$/);
  const target = m ? link.text.slice(0, m.index) : link.text;
  return { kind: "file", target, line: m ? Number.parseInt(m[1], 10) : undefined };
}
