// 界面度量契约守卫：把「行高唯一来源、表头与行同栅格、命中区 ≥28、左栏 12px 节奏、
// 同名元素只允许一处定义」这些已判定规则固化下来，防止同类问题再次回归。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cssFile = resolve(root, "src/styles/base.css");
const raw = readFileSync(cssFile, "utf8");
const lines = raw.split(/\r?\n/);

// ---- 令牌 ----
const tokens = new Map();
for (const m of raw.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());

const px = (value) => {
  if (value == null) return null;
  let v = value.trim();
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref && tokens.has(ref[1])) v = tokens.get(ref[1]);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const shorthandSides = (value) => {
  // 返回 [上, 右, 下, 左]
  const ref = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref && tokens.has(ref[1])) value = tokens.get(ref[1]);
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
};

// ---- 解析规则（跳过注释；@media 外壳不参与匹配） ----
const clean = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const rules = [];
for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim().replace(/\s+/g, " ");
  if (!sel || sel.startsWith("@")) continue;
  const body = m[2];
  const decls = {};
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  const line = clean.slice(0, m.index).split("\n").length;
  for (const one of sel.split(",").map((s) => s.trim()).filter(Boolean)) {
    rules.push({ sel: one, decls, line });
  }
}
const effective = (sel) => {
  const out = { __lines: [] };
  for (const r of rules) {
    if (r.sel === sel) {
      Object.assign(out, r.decls);
      out.__lines.push(r.line);
    }
  }
  return out;
};
const count = (sel) => rules.filter((r) => r.sel === sel).length;

const problems = [];
const fail = (msg) => problems.push(msg);

// ---- 1. 命中区 ≥ 28×28 ----
const HIT = [
  [".rail-head .add", ".app--next .rail-head .add"],
  [".srow__x", ".app--next .srow__x"],
  [".qrow2 .qa", ".app--next .qrow2 .qa"],
  [".qhead2 .qb", ".app--next .qhead2 .qb"],
  [".dop", ".app--next .dop"],
  [".sb-toggle", ".app--next .sb-toggle"],
  [".topbar .iconbtn", ".app--next .topbar .iconbtn"],
  [".crumb2 .cb", ".app--next .crumb2 .cb"],
];
for (const candidates of HIT) {
  let decl = null;
  for (const c of candidates) if (count(c)) decl = { c, ...effective(c) };
  if (!decl) {
    fail(`命中区检查：找不到 ${candidates[0]} 的尺寸声明`);
    continue;
  }
  const w = px(decl["min-width"] ?? decl.width);
  const h = px(decl["min-height"] ?? decl.height);
  if (w != null && w < 28) fail(`base.css:${decl.__lines.at(-1)}  ${decl.c} 宽 ${w} < 28（命中区下限）`);
  if (h != null && h < 28) fail(`base.css:${decl.__lines.at(-1)}  ${decl.c} 高 ${h} < 28（命中区下限）`);
}
// 分段按钮：由容器高度 - 上下内边距得出
{
  const seg = effective(".app--next .seg").height ? effective(".app--next .seg") : effective(".seg");
  const bh = px(seg.height ?? "0");
  const pad = shorthandSides(seg.padding ?? "0");
  const inner = bh - px(pad[0]) - px(pad[2]);
  if (!(inner >= 28)) fail(`base.css  分段按钮命中高 ${inner} < 28（.seg 高度 ${bh} - 内边距）`);
}
{
  const back = count(".app--next .conntop .back") ? effective(".app--next .conntop .back") : effective(".conntop .back");
  const h = px(back["min-height"] ?? back.height ?? "0");
  if (h < 28) fail(`base.css  连接页返回按钮高 ${h} < 28（命中区下限）`);
}

// ---- 2. 文件行高唯一来源 ----
const filePane = readFileSync(resolve(root, "src/features/sftp/FilePane.tsx"), "utf8");
const rowH = Number((filePane.match(/const ROW_H\s*=\s*(\d+)/) || [])[1]);
for (const sel of [".frow", ".app--next .frow"]) {
  const h = px(effective(sel).height ?? "0");
  if (rowH && h !== rowH) fail(`base.css  ${sel} 高度 ${h} ≠ FilePane ROW_H ${rowH}`);
}

// ---- 3. 表头与行同栅格 ----
{
  const row = effective(".app--next .frow");
  const col = effective(".app--next .colrow");
  if (row["grid-template-columns"] !== col["grid-template-columns"]) {
    fail(`base.css  表头栅格 ${col["grid-template-columns"]} ≠ 文件行栅格 ${row["grid-template-columns"]}`);
  }
  for (const sel of [".frow .sz", ".frow .dt", ".app--next .frow .sz", ".app--next .frow .dt"]) {
    const w = effective(sel).width;
    if (w) fail(`base.css  ${sel} 固定宽 ${w} 会脱离共用栅格，删除该 width`);
  }
}

// ---- 4. 左栏 12px 左右节奏 ----
const GUTTER = [
  [".rail", "padding", 0, 0],
  [".rail-head", "padding", 12, 12],
  [".glabel", "padding", 12, 12],
  [".rail-foot", "padding", 12, 12],
  [".seg", "margin", 12, 12],
  [".railsearch", "margin", 12, 12],
];
for (const [sel, prop, left, right] of GUTTER) {
  const v = effective(sel)[prop];
  if (!v) {
    fail(`base.css  ${sel} 缺少 ${prop}，无法保证 12px 节奏`);
    continue;
  }
  const sides = shorthandSides(v);
  const l = px(sides[3]);
  const r = px(sides[1]);
  if (l !== left || r !== right) fail(`base.css  ${sel} ${prop} 左右 ${l}/${r} ≠ ${left}/${right}`);
}

// ---- 5. 面板内同名元素只允许一处定义（防漂移） ----
const UNIQUE = [".app--next .sbtab", ".app--next .sb-toggle", ".app--next .dops", ".app--next .dop"];
for (const sel of UNIQUE) {
  const n = count(sel);
  if (n > 1) fail(`base.css  ${sel} 重复定义 ${n} 次，保留最后一处并删除旧块`);
}

// ---- 6. 队列头/行、抽屉头/操作行与行内容同左缘 ----
{
  const qh = px(shorthandSides(effective(".app--next .qhead2").padding ?? "0")[3]);
  const qr = px(shorthandSides(effective(".app--next .qrow2").padding ?? "0")[3]);
  if (qh !== qr) fail(`base.css  队列头左右 ${qh} ≠ 队列行 ${qr}`);
  const dh = px(shorthandSides(effective(".app--next .drawer .filehead").padding ?? "0")[3]);
  const dr = px(shorthandSides(effective(".app--next .frow").padding ?? "0")[3]);
  const dops = px(shorthandSides(effective(".app--next .dops").padding ?? "0")[3]);
  if (dh !== dr || dops !== dr) fail(`base.css  抽屉头/操作行左右 ${dh}/${dops} ≠ 文件行 ${dr}`);
}

if (problems.length) {
  console.error(`界面度量检查失败：${problems.length} 条`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `界面度量检查通过：命中区 ${HIT.length} 项 ≥28，文件行高 ${rowH}px 单源，表头/行同栅格，左栏 ${GUTTER.length} 处 12px 节奏，同名选择器 ${UNIQUE.length} 项唯一`,
);
