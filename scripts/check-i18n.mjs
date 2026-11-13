// 未翻译字符串扫描 + 目录完整性检查。
//   1. 扫 src 下所有 ts/tsx，凡是不在 tr(...) 里的中文都视为未翻译（可白名单）。
//   2. 扫代码里用到的 tr("...") 键，检查五个语种目录是否齐全。
//   3. 检查 en/es 译文里是否残留汉字（ja/zh-TW 允许汉字）。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const srcDir = resolve(root, "src");
const CJK = /[\u4e00-\u9fff]/;

// 允许保留原文的专有名词/协议名（刻意不译，需在 docs/design/i18n.md 说明理由）
const ALLOW = [
  "Shellora", "SSH", "SFTP", "PTY", "SFTP-DE", "WebDAV", "OpenSSH", "PPK",
  "One Dark", "GitHub", "Windows", "macOS", "Linux", "Tauri", "Rust", "Vite",
  "MiB/s", "KiB/s", "SHA256", "ETag", "Ed25519", "RSA", "ECDSA", "AES", "HMAC",
];

// 不面向用户的文件：单测用例名、无头预览夹具、启动兜底报错（只在开发期出现）。
// 理由写在 docs/design/i18n.md「刻意保留原文」一节。
const SKIP_FILES = [
  "src/lib/ipc/preview.ts",
  "src/main.tsx",
];
const SKIP_FILE_RE = /\.test\.(ts|tsx)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) {
      if (["node_modules", "__tests__", "i18n"].includes(name)) continue;
      walk(full, out);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// 把 tr("…") 的内容整体遮掉，剩下的中文就是漏网之鱼
function maskTr(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("tr(", i);
    if (at === -1) {
      out += text.slice(i);
      break;
    }
    const prev = text[at - 1] ?? "";
    if (/[\w$.]/.test(prev)) {
      out += text.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    out += text.slice(i, at) + "tr(";
    let j = at + 3;
    let depth = 1;
    let quote = "";
    while (j < text.length && depth > 0) {
      const ch = text[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
    // 保留换行以维持行号
    out += "\n".repeat((text.slice(at, j).match(/\n/g) ?? []).length);
    i = j;
  }
  return out;
}

const files = walk(srcDir);
const untranslated = [];
const keys = new Map(); // key -> first file:line

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const rel = relative(root, file);
  if (SKIP_FILES.includes(rel.replace(/\\/g, "/")) || SKIP_FILE_RE.test(rel)) continue;
  // 先按整个文件遮罩 tr(...)，再逐行扫描：这样跨行的 tr("…") 也不会被误报。
  const maskedLines = maskTr(raw).split(/\r?\n/);
  raw.split(/\r?\n/).forEach((line, idx) => {
    const stripped = (maskedLines[idx] ?? "").replace(/\/\/.*$/, "");
    // 控制台日志只给开发者看，不进界面，不算未翻译文案。
    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(line)) return;
    const masked = stripped;
    // 行内字符串与 JSX 文本
    const hits = [];
    for (const m of masked.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
      const s = m[1] ?? m[2] ?? m[3] ?? "";
      if (CJK.test(s)) hits.push(s);
    }
    const jsx = masked.match(/>([^<>{}\n]*)</);
    if (jsx && CJK.test(jsx[1])) hits.push(jsx[1].trim());
    for (const s of hits) {
      if (ALLOW.some((w) => s.trim() === w)) continue;
      if (/^\s*[\u4e00-\u9fff]{0,2}\s*[:：]?\s*$/.test(s)) continue; // 单字分隔符
      untranslated.push(`${rel}:${idx + 1}  ${s.trim().slice(0, 60)}`);
    }
  });

  for (const m of raw.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = JSON.parse(`"${m[1]}"`);
    if (!keys.has(key)) {
      const line = raw.slice(0, m.index).split("\n").length;
      keys.set(key, `${rel}:${line}`);
    }
  }
}

// 目录完整性
const locales = ["en", "zh-TW", "ja", "es"];
const missing = [];
const cjkInLatin = [];
for (const loc of locales) {
  const file = resolve(srcDir, "i18n/locales", `${loc}.ts`);
  if (!existsSync(file)) {
    missing.push(`${loc}.ts 不存在`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const [key, where] of keys) {
    if (!text.includes(JSON.stringify(key))) missing.push(`${loc}.ts 缺键（${where}）: ${key}`);
  }
  if (loc === "en" || loc === "es") {
    // 只看「值」，key 本身是中文原文，不能算残留汉字。
    for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const value = m[1];
      if (CJK.test(value)) cjkInLatin.push(`${loc}.ts 含汉字: ${value}`);
    }
  }
}

console.log(`tr() 键：${keys.size} 条；扫描文件：${files.length} 个`);
console.log(`未翻译中文：${untranslated.length} 条`);
for (const u of untranslated.slice(0, 80)) console.log(`  - ${u}`);
console.log(`目录缺键：${missing.length} 条`);
for (const m of missing.slice(0, 40)) console.log(`  - ${m}`);
console.log(`英文/西语残留汉字：${cjkInLatin.length} 条`);
for (const c of cjkInLatin.slice(0, 20)) console.log(`  - ${c}`);

const failed = untranslated.length + missing.length + cjkInLatin.length > 0;
if (failed) process.exit(1);
console.log("i18n 检查通过：0 条未翻译");
