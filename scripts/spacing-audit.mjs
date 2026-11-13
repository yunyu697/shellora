// 间距现状审计：统计 CSS 与内联样式里的 padding / margin / gap / 行高取值。
// 只读脚本，输出 Markdown 表格，供 docs/design/spacing.md 引用。
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { globSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const SPACING = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$/;

function walk(dir, ext, out = []) {
  for (const entry of globSync(`${dir.replaceAll("\\", "/")}/**/*${ext}`)) out.push(entry);
  return out;
}

const cssFiles = walk(resolve(root, "src"), ".css");
const tsxFiles = walk(resolve(root, "src"), ".tsx");
const tsFiles = walk(resolve(root, "src"), ".ts").filter((f) => !f.includes("__tests__"));

const cssCounts = new Map();
const cssFilesByValue = new Map();
let cssDecls = 0;
let rawDecls = 0;

for (const file of cssFiles) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([a-z-]+)\s*:\s*([^;]+);/);
    if (!m) return;
    if (!SPACING.test(m[1])) return;
    cssDecls += 1;
    const value = m[2].trim();
    if (value.includes("var(--sp-")) return;
    if (!/\d/.test(value)) return; // 0 / auto / 100%
    rawDecls += 1;
    const px = [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1]));
    const key = px.length ? px.map((n) => `${n}px`).join(" ") : value;
    cssCounts.set(key, (cssCounts.get(key) ?? 0) + 1);
    const where = cssFilesByValue.get(key) ?? new Set();
    where.add(`${relative(root, file)}:${i + 1}`);
    cssFilesByValue.set(key, where);
  });
}

const inline = [];
for (const file of [...tsxFiles, ...tsFiles]) {
  const text = readFileSync(file, "utf8");
  const re = /(?:^|[{,\s])(padding|margin|gap|rowGap|columnGap|marginTop|marginRight|marginBottom|marginLeft|paddingTop|paddingRight|paddingBottom|paddingLeft)\s*:\s*("([^"]*\d+px[^"]*)"|-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[3] && m[3].includes("var(--sp-")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    inline.push(`${relative(root, file)}:${line}  ${m[1]}: ${m[2]}`);
  }
}

const rows = [...cssCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`# 间距现状审计\n`);
console.log(`- CSS 间距声明：${cssDecls} 条，其中裸值 ${rawDecls} 条、令牌 ${cssDecls - rawDecls} 条`);
console.log(`- 内联间距写法：${inline.length} 处\n`);
console.log(`| 裸值 | 次数 | 出现位置（前 3 处） |`);
console.log(`| --- | ---: | --- |`);
for (const [value, count] of rows) {
  const where = [...(cssFilesByValue.get(value) ?? [])].slice(0, 3).join("<br>");
  console.log(`| ${value} | ${count} | ${where} |`);
}
if (inline.length) {
  console.log(`\n## 内联样式\n`);
  for (const line of inline) console.log(`- ${line}`);
}
