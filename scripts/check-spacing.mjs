// 间距令牌守卫：CI 里拦住新写的裸 px 边距与不在档位内的间距值。
//
// 规则：
//   1. padding / margin / gap / row-gap / column-gap（含四个方向的长写）只能是
//      0 或 var(--sp-N)；var 名必须是已定义的令牌。
//   2. 令牌定义值必须落在 2 / 4 / 8 / 12 / 16 / 24 / 32 / 48 这八个档位内。
//   3. line-height 只能用无单位数或 var(--lh-*)。
//   4. TSX 内联样式里的间距属性同样只允许 var(--sp-N) 字符串。
//   5. 平台常量（如 macOS 红绿灯让位）允许在行尾写 `no-sp-token: 理由` 放行。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SCALE = new Set([2, 4, 8, 12, 16, 24, 32, 48]);
const SPACING = /^\s*(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?\s*:\s*([^;]+);/;
const INLINE = /(?:^|[{,\s])(padding|margin|gap|rowGap|columnGap|marginTop|marginRight|marginBottom|marginLeft|paddingTop|paddingRight|paddingBottom|paddingLeft)\s*:\s*("([^"]*)"|-?\d+(?:\.\d+)?)/g;

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      walk(full, exts, out);
    } else if (exts.some((e) => name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const problems = [];

// ---- 1. 令牌定义 ----
const tokens = new Map();
for (const file of walk(resolve(root, "src"), [".css"])) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/(--(?:sp|lh)-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2].trim();
    tokens.set(name, value);
    if (name.startsWith("--sp-")) {
      const px = Number(value.replace("px", ""));
      if (!SCALE.has(px)) {
        problems.push(`${relative(root, file)}  ${name}: ${value} 不在档位 ${[...SCALE].join("/")} 内`);
      }
    }
  }
}

// ---- 2. CSS 声明 ----
let cssChecked = 0;
for (const file of walk(resolve(root, "src"), [".css"])) {
  const text = readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((line, i) => {
    const where = `${relative(root, file)}:${i + 1}`;
    const m = line.match(SPACING);
    if (m) {
      cssChecked++;
      const value = m[4].trim();
      if (line.includes("no-sp-token:")) return;
      if (value === "0") return;
      const bare = value.replace(/var\([^)]*\)/g, "");
      if (/\d+(?:\.\d+)?px/.test(bare)) {
        problems.push(`${where}  裸 px 间距: ${value.trim()}`);
      }
      for (const ref of value.matchAll(/var\((--(?:sp|lh)-[a-z0-9-]+)/g)) {
        if (!tokens.has(ref[1])) problems.push(`${where}  未定义的间距令牌: ${ref[1]}`);
      }
    }
    const lh = line.match(/^\s*line-height:\s*([^;]+);/);
    if (lh && !line.includes("no-sp-token:")) {
      const v = lh[1].trim();
      if (/\dpx/.test(v) && !v.includes("var(--lh-")) problems.push(`${where}  行高必须是 var(--lh-*) 或无单位数: ${v}`);
      for (const ref of v.matchAll(/var\((--lh-[a-z0-9-]+)/g)) {
        if (!tokens.has(ref[1])) problems.push(`${where}  未定义的行高令牌: ${ref[1]}`);
      }
    }
  });
}

// ---- 3. 内联样式 ----
let inlineChecked = 0;
for (const file of walk(resolve(root, "src"), [".tsx", ".ts"])) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(INLINE)) {
    inlineChecked++;
    const line = text.slice(0, m.index).split("\n").length;
    const raw = m[3] !== undefined ? m[3] : m[2];
    if (String(raw).includes("var(--sp-")) continue;
    problems.push(`${relative(root, file)}:${line}  内联间距裸值: ${m[1]}: ${m[2]}`);
  }
}

if (problems.length) {
  console.error(`间距检查失败：${problems.length} 条`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `间距检查通过：CSS ${cssChecked} 条间距声明、内联 ${inlineChecked} 处；令牌 ${tokens.size} 个，档位 ${[...SCALE].join("/")}px`,
);
