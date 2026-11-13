// 粘贴保护：多行/控制字符确认；bracketed paste 包装；选中文本规范化。
// 纯函数，UI 与单测共用同一判定，避免"弹窗说 3 行、实际发 4 行"。
import { tr } from "../../i18n";

export interface PasteGuardOptions {
  /** 每次粘贴都确认（设置项 confirm_always） */
  confirmAlways?: boolean;
}

export interface PasteAnalysis {
  /** 逻辑行数（末尾换行不额外算一行） */
  lineCount: number;
  charCount: number;
  hasNewline: boolean;
  hasControlChar: boolean;
  needsConfirm: boolean;
  /** 弹窗主文案；needsConfirm 为 false 时是单行摘要 */
  summary: string;
}

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function summarizePasteLineCount(text: string): number {
  if (text.length === 0) return 0;
  const normalized = normalizeNewlines(text);
  const parts = normalized.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

export function analyzePaste(text: string, options?: PasteGuardOptions): PasteAnalysis {
  const lineCount = summarizePasteLineCount(text);
  const hasNewline = /[\r\n]/.test(text);
  const hasControlChar = CONTROL_RE.test(text);
  const needsConfirm = Boolean(options?.confirmAlways) || hasNewline || hasControlChar;

  const risks: string[] = [];
  if (hasNewline) risks.push(tr("含回车"));
  if (hasControlChar) risks.push(tr("含控制字符"));
  if (!risks.length && options?.confirmAlways) risks.push(tr("已开启每次确认"));

  const summary = needsConfirm
    ? tr("将粘贴 {lines} 行（{risks}），可能立即执行", {
        lines: lineCount,
        risks: risks.join(tr("、")),
      })
    : tr("将粘贴 {lines} 行、{chars} 字符", { lines: lineCount, chars: text.length });

  return {
    lineCount,
    charCount: text.length,
    hasNewline,
    hasControlChar,
    needsConfirm,
    summary,
  };
}

/** T09：bracketed paste 开启时包 ESC[200~ … ESC[201~，否则原样发送。 */
export function wrapBracketedPaste(text: string, bracketed: boolean): string {
  if (!bracketed) return text;
  return `\x1b[200~${text}\x1b[201~`;
}

/** T12：选中复制不留多余的 \r，且去掉末尾一个换行（xterm 选区常带行尾）。 */
export function normalizeSelection(text: string): string {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
}
