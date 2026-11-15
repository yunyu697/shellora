// 界面规范守卫：把 docs/design/ui-spec.md 的表格变成可执行断言。
// 与 check-ui-metrics.mjs（结构度量）互补，这里只管「值是否来自令牌阶梯」。
// 用法：
//   node scripts/check-ui-spec.mjs            # 正常检查
//   node scripts/check-ui-spec.mjs --self-test # 负向自检：每类违规必须被捕获
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cssPath = resolve(root, "src/styles/base.css");
const tauriPath = resolve(root, "src-tauri/tauri.conf.json");
const exemptionPath = resolve(root, "docs/design/ui-spec-exemptions.json");
const SELF_TEST = process.argv.includes("--self-test");

// ---------- 阶梯（规范的机器可读副本） ----------
const LADDER = {
  fs: { "2xs": 10, xs: 11, sm: 12, md: 13, lg: 15, xl: 17 },
  lh: { "2xs": 13, xs: 15, sm: 16, md: 18, lg: 20, xl: 22 },
  r: { control: 6, card: 8 },
  ctl: { "3xs": 16, "2xs": 20, xs: 22, sm: 24, md: 28, lg: 32, xl: 36, "2xl": 40, "3xl": 44, "4xl": 56 },
  icon: { "2xs": 10, xs: 12, sm: 14, md: 16, lg: 20, xl: 24 },
  box: { sm: 22, xs: 24, md: 26, lg: 30, xl: 36 },
  dur: { 1: 90, 2: 120, 3: 160, 4: 200 },
  sp: { 0: 2, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 },
};

// 语义别名：列表主行与正文同档（12px 只做辅助，不再承担主行）
const FS_ALIAS = { list: "md" };

// 最小窗口：低于此值没有布局模型，改为不可达（src-tauri/tauri.conf.json）
const MIN_WINDOW = { width: 640, height: 480 };

// 悬停底色对行底的 WCAG 对比度下限：低于此值视觉上"没有反馈"
const HOVER_MIN = 1.08;

// 辅助字号白名单：10px 只放计数/角标/单位，11px 只放等宽元信息与全大写标签。
// 新增条目必须同步 docs/design/ui-spec.md §2.1 的类别登记。
const AUX_FS_ALLOW = [
  { re: /(^|[\s>])kbd\b/, cat: "按键角标" },
  { re: /\.count\b/, cat: "计数" },
  { re: /\.cnt2?\b/, cat: "计数" },
  { re: /\.num\b/, cat: "计数" },
  { re: /\.sz\b/, cat: "单位（体积）" },
  { re: /\.dt\b/, cat: "时间戳" },
  { re: /\.pct\b/, cat: "单位（百分比）" },
  { re: /\.rate\b/, cat: "单位（速率）" },
  { re: /\.eta\b/, cat: "单位（剩余时间）" },
  { re: /\.ffoot\b/, cat: "计数" },
  { re: /\.axis\b/, cat: "图表刻度" },
  { re: /\.spd\b/, cat: "单位（速率）" },
  { re: /\.qbadge\b/, cat: "角标" },
  { re: /\.warnchip\b/, cat: "角标" },
  { re: /\.hostchip\b/, cat: "角标" },
  { re: /\.tagrow\b/, cat: "角标" },
  { re: /\.opt\b/, cat: "角标" },
  { re: /\.scope\b/, cat: "角标" },
  { re: /\.sep\b/, cat: "分隔符" },
  { re: /\.qchild(__size)?\b/, cat: "计数 / 单位" },
  { re: /\.applyrow \.r\b/, cat: "计数" },
  { re: /\.upd-date\b/, cat: "时间戳" },
  { re: /\.avatar\b/, cat: "首字母角标" },
  { re: /\.glabel\b/, cat: "全大写分组标签" },
  { re: /\.srow \.mt\b/, cat: "等宽元信息" },
  { re: /\.usercard\b/, cat: "等宽元信息" },
  { re: /\.qrow2\b/, cat: "等宽元信息" },
  { re: /\.termbar \.meta\b/, cat: "等宽元信息" },
  { re: /\.fcard2 \.meta2\b/, cat: "等宽元信息" },
  { re: /\.xmeta\b/, cat: "等宽元信息" },
  { re: /\.fhead \.sub\b/, cat: "等宽元信息" },
  { re: /\.qrow2 \.nm \.p\b/, cat: "等宽元信息" },
  { re: /\.conntop \.sub\b/, cat: "等宽元信息" },
  { re: /\.ehead2 \.sub\b/, cat: "等宽元信息" },
  { re: /\.drawer__host\b/, cat: "等宽元信息" },
  { re: /\.drawer__w\b/, cat: "等宽元信息" },
  { re: /\.drawer \.filehead \.hostchip\b/, cat: "角标" },
  { re: /\.fingerprint dd\b/, cat: "等宽元信息" },
  { re: /\.statusbar\b/, cat: "状态栏计数 / 模式" },
  { re: /\.dops__sel\b/, cat: "计数" },
  { re: /\.upd-title p\b/, cat: "等宽元信息" },
  { re: /\.upd-from\b/, cat: "等宽元信息" },
  { re: /\.upd-size\b/, cat: "单位" },
  { re: /\.upd-progress__meta\b/, cat: "等宽元信息" },
  { re: /\.upd-error__code\b/, cat: "等宽元信息" },
];
const auxCategory = (sel) => AUX_FS_ALLOW.find((a) => a.re.test(sel))?.cat || null;

// ---------------- 圆角：4 档单一来源 ----------------
// 卡片（容器）/ 控件（按钮、输入、标签、行内小块）/ 胶囊（圆头条状）/ 全圆（正圆）。
// 规则与白边成因见 docs/design/ui-spec.md §5。
const RADIUS_TOKENS = new Set(["--r-card", "--r-control", "--r-pill", "--r-full"]);
// 容器类：半径归卡片档。新增容器必须登记在这里，否则默认按控件档校验。
const RADIUS_CARD_FAMILIES = new Set([
  "modal", "settings-card", "conflict__card", "paste-guard__card", "confdlg2",
  "fcard2", "scard", "queue2", "fpanel", "termcard", "termcard--stage", "editor2",
  "ctxmenu", "drawer", "rail", "newcon", "opt2", "settings-radio", "settings-field",
  "tray-toast", "upd-notes", "upd-error",
]);
// 控件类：不得使用卡片档（与上面冲突时以容器登记为准）。
const RADIUS_CONTROL_RE =
  /(btn|input|select|chip|badge|tab|kbd|chk|tile|dot|swatch|radio|seg|count|bar|prog|add|close|grip|ico|icon|scope|opt|field|item|row|cell|mark|x|pill)$/;

/** 取选择器最后一个复合选择器里的类名作为「族」，用于同族一致性比对。 */
function radiusFamily(sel) {
  const base = sel.replace(/::?[a-z-]+(\([^)]*\))?/g, "").trim();
  const last = base.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || "";
  const cls = last.match(/\.([A-Za-z0-9_-]+)/);
  if (cls) return cls[1];
  const el = last.match(/^[a-z]+/i);
  return el ? `#${el[0]}` : null;
}



const PX_PROPS = new Set([
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "gap", "row-gap", "column-gap",
  "font-size", "line-height", "letter-spacing", "font-weight",
  "border-radius", "border-width", "outline-offset",
  "transition", "transition-duration", "animation", "animation-duration",
]);
const ICON_SEL = /(\.ic\b|\.dot\b|\.st\b|\.mini-st\b|\.upd-dot\b|\.chk\b)/;
const CONTROL_SEL = /(\.btn\b|\.iconbtn\b|\.dop\b|\.qa\b|\.qb\b|\.cb\b|\.ab\b|\.ib\b|\.add\b|\.sb-toggle\b|\.sbtab__x\b|\.termtab__close\b|\.mini-add\b|\.wc\b|\.minirow\b|\bkbd\b|\.srow__x\b|\.drawer__x\b)/;
const SIZE_PROPS = new Set(["width", "height", "min-width", "max-width", "min-height", "max-height"]);

function loadExemptions() {
  if (!existsSync(exemptionPath)) throw new Error(`缺少豁免清单：${relative(root, exemptionPath)}`);
  const data = JSON.parse(readFileSync(exemptionPath, "utf8"));
  const list = data.exemptions || [];
  for (const [i, e] of list.entries()) {
    for (const k of ["selector", "property", "value", "reason", "owner"]) {
      if (!e[k] || String(e[k]).trim() === "") throw new Error(`豁免清单第 ${i + 1} 条缺少 ${k}`);
    }
    if (e.reason.length < 4) throw new Error(`豁免清单第 ${i + 1} 条 reason 过短，需说明布局理由`);
    if (!SIZE_PROPS.has(e.property)) throw new Error(`豁免清单第 ${i + 1} 条只能豁免布局宽高，不能豁免 ${e.property}`);
  }
  return list;
}

// ---------- 核心扫描 ----------
function analyze(cssText, { withTokens = true, exemptions = [] } = {}) {
  const problems = [];
  const fail = (msg) => problems.push(msg);
  const rawLines = cssText.split(/\r?\n/);
  const hasNoTokenMark = (line) => /no-(ui|sp)-token/.test(rawLines[line - 1] || "");

  const tokens = new Map();
  for (const m of cssText.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());
  const resolveToken = (value, depth = 0) => {
    if (typeof value !== "string") return "";
    if (depth > 6) return value;
    const ref = value.trim().match(/^var\((--[a-z0-9-]+)\)$/);
    if (ref && tokens.has(ref[1])) return resolveToken(tokens.get(ref[1]), depth + 1);
    return value.trim();
  };
  const num = (v) => {
    const n = parseFloat(resolveToken(v));
    return Number.isFinite(n) ? n : null;
  };

  if (withTokens) {
    for (const [group, steps] of Object.entries(LADDER)) {
      const prefix = group === "dur" ? "--dur-" : group === "sp" ? "--sp-" : `--${group}-`;
      for (const [k, expected] of Object.entries(steps)) {
        const name = `${prefix}${k}`;
        if (!tokens.has(name)) { fail(`令牌缺失：${name}（阶梯要求 ${expected}px）`); continue; }
        if (num(tokens.get(name)) !== expected) fail(`令牌越档：${name} = ${tokens.get(name)}，阶梯要求 ${expected}px`);
      }
    }
    for (const k of Object.keys(LADDER.fs)) if (!tokens.has(`--lh-${k}`)) fail(`行高未成组：缺 --lh-${k}（对应 --fs-${k}）`);
    if (num(tokens.get("--hit-min")) !== 28) fail(`--hit-min 必须是 28px，实际 ${tokens.get("--hit-min")}`);
    if (resolveToken(tokens.get("--r-pill")) !== "999px") fail(`--r-pill 必须是 999px，实际 ${tokens.get("--r-pill")}`);
    if (resolveToken(tokens.get("--r-full")) !== "50%") fail(`--r-full 必须是 50%，实际 ${tokens.get("--r-full")}`);
    for (const legacy of ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"]) {
      if (tokens.has(`--r-${legacy}`)) fail(`圆角只保留 4 档，--r-${legacy} 必须删除`);
    }
  }

  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rules = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (!sel || sel.startsWith("@")) continue;
    const selLine = clean.slice(0, m.index).split("\n").length;
    const decls = [];
    const bodyStart = m.index + m[0].indexOf("{") + 1;
    let cursor = 0;
    for (const part of m[2].split(";")) {
      const i = part.indexOf(":");
      if (i >= 0) {
        const line = clean.slice(0, bodyStart + cursor + i).split("\n").length;
        decls.push({ prop: part.slice(0, i).trim().toLowerCase(), value: part.slice(i + 1).trim(), line });
      }
      cursor += part.length + 1;
    }
    for (const one of sel.split(",").map((s) => s.trim()).filter(Boolean)) rules.push({ sel: one, decls, line: selLine });
  }

  const usedExemptions = new Set();
  const radiusUse = [];
  let bareCount = 0;
  for (const r of rules) {
    for (const d of r.decls) {
      const { prop, value, line } = d;
      if (prop.startsWith("--")) continue;
      const where = `base.css:${line}  ${r.sel}  ${prop}: ${value}`;
      const bare = /\d+(\.\d+)?px/.test(value) && !hasNoTokenMark(line);
      const inScope = PX_PROPS.has(prop) || SIZE_PROPS.has(prop) || /^border(-|$)/.test(prop) || prop === "stroke-width";
      if (bare && inScope) bareCount += 1;

      if (PX_PROPS.has(prop) && bare) { fail(`${where}  —— 裸 px，必须用令牌`); }
      if (prop === "font-size" && !/^var\(--fs-/.test(value)) fail(`${where}  —— 字号必须取自 --fs-* 阶梯`);
      if (prop === "font-size") {
        const step = value.match(/^var\(--fs-([a-z0-9]+)\)$/)?.[1];
        const real = step ? FS_ALIAS[step] ?? step : null;
        if (step && real && LADDER.fs[real] == null) fail(`${where}  —— 字号不在 6 档阶梯内`);
        if (step && real && LADDER.fs[real] < LADDER.fs.sm && !auxCategory(r.sel)) {
          fail(
            `${where}  —— 正文/可读标签不得低于 12px（--fs-sm）；` +
              `--fs-${step}(${LADDER.fs[real]}px) 仅限计数/角标/单位等辅助信息，确属辅助请登记 AUX_FS_ALLOW 与 ui-spec.md §2.1`,
          );
        }
      }
      if (prop === "line-height") {
        if (!/^var\(--lh-/.test(value)) fail(`${where}  —— 行高必须取自 --lh-* 阶梯`);
        else {
          const name = value.match(/var\((--[a-z0-9-]+)\)/)?.[1];
          const allowed = new Set([
            ...Object.keys(LADDER.lh).map((k) => `--lh-${k}`),
            "--lh-none", "--lh-flat", "--lh-prose", "--lh-tight", "--lh-small", "--lh-body",
          ]);
          if (!allowed.has(name)) fail(`${where}  —— 行高不在阶梯内`);
          else {
            const px = num(tokens.get(name));
            if (px != null && !Object.values(LADDER.lh).includes(px) && !["--lh-none", "--lh-flat", "--lh-prose"].includes(name)) {
              fail(`${where}  —— 行高 ${px}px 不在阶梯内`);
            }
          }
        }
      }
      if (prop === "letter-spacing" && value !== "0" && !/^var\(--ls-/.test(value)) fail(`${where}  —— 字距必须取自 --ls-*`);
      if (prop === "font-weight" && !/^var\(--fw-/.test(value)) fail(`${where}  —— 字重必须取自 --fw-*`);
      if (prop === "border-radius" && !/^(inherit|0)$/.test(value)) {
        const parts = value.match(/var\(--r-[a-z0-9]+\)|\d+(\.\d+)?(px|%)/g) || [];
        if (!parts.length || parts.some((p) => !/^var\(--r-/.test(p))) {
          fail(`${where}  —— 圆角必须取自 --r-*，禁止裸值`);
        } else {
          for (const p of parts) {
            const token = p.slice(4, -1);
            if (!RADIUS_TOKENS.has(token)) {
              fail(
                `${where}  —— 圆角只有 4 档（--r-card / --r-control / --r-pill / --r-full），` +
                  `${token} 是越档值`,
              );
              continue;
            }
            const family = radiusFamily(r.sel);
            if (!family) continue;
            radiusUse.push({ family, token, where });
            if (RADIUS_CARD_FAMILIES.has(family)) {
              if (token !== "--r-card") fail(`${where}  —— 容器类 ${family} 必须用 --r-card（卡片档）`);
            } else if (!family.startsWith("#") && RADIUS_CONTROL_RE.test(family)) {
              if (token === "--r-card") fail(`${where}  —— 控件类 ${family} 只能用 --r-control / --r-pill / --r-full，不得用卡片档`);
            }
          }
        }
      }
      if (prop === "stroke-width" && !/^var\(--isw-/.test(value)) fail(`${where}  —— 图标线宽必须取自 --isw-*`);
      if (/^border(-(top|right|bottom|left))?$/.test(prop) && /^[\d.]+px/.test(value)) fail(`${where}  —— 描边宽度必须取自 --bw-*`);
      if ((prop === "transition" || prop === "animation") && /\b\d+(\.\d+)?m?s\b/.test(value)) fail(`${where}  —— 时长必须取自 --dur-*`);
      if (prop === "opacity" && /:disabled\b/.test(r.sel) && !/^var\(--state-disabled-opacity\)$/.test(value)) fail(`${where}  —— 禁用透明度必须用 --state-disabled-opacity`);
      if ((prop === "background" || prop === "background-color") && /:hover\b/.test(r.sel) &&
          !/^var\(--state-hover/.test(value) && !/^(transparent|none|inherit)$/.test(value)) {
        fail(`${where}  —— 悬停色必须取自 --state-hover*`);
      }
      if ((prop === "width" || prop === "height") && ICON_SEL.test(r.sel) && !/^var\(--(icon|dot|box)-/.test(value) && bare) fail(`${where}  —— 图标尺寸必须取自 --icon-* / --dot-* / --box-*`);
      if ((prop === "width" || prop === "height") && CONTROL_SEL.test(r.sel) && bare) fail(`${where}  —— 控件尺寸必须取自 --ctl-* / --icon-*`);
      if ((prop === "width" || prop === "height") && ICON_SEL.test(r.sel) && /^var\(--(icon|box)-/.test(value)) {
        const pair = r.decls.find((x) => x.prop === (prop === "width" ? "height" : "width"));
        if (pair && pair.value !== value) fail(`${where}  —— 图标宽高必须同档（对面是 ${pair.value}）`);
      }

      // 布局宽高：要么令牌化，要么在版本控制的豁免清单里登记
      if (SIZE_PROPS.has(prop) && bare && !/no-ui-token/.test(value)) {
        const hit = exemptions.find((e) => e.selector === r.sel && e.property === prop && e.value === value.trim());
        if (hit) usedExemptions.add(hit);
        else fail(`${where}  —— 宽高裸 px 未令牌化且未登记豁免（docs/design/ui-spec-exemptions.json）`);
      }
    }

    // 行高成组：同一规则里行高不得低于该字号档的配对标高
    const fsDecl = r.decls.find((x) => x.prop === "font-size");
    const lhDecl = r.decls.find((x) => x.prop === "line-height");
    if (fsDecl && lhDecl) {
      const fsStep = fsDecl.value.match(/var\(--fs-([a-z0-9]+)\)/)?.[1];
      const lhStep = lhDecl.value.match(/var\(--lh-([a-z0-9]+)\)/)?.[1];
      if (fsStep && lhStep && LADDER.lh[lhStep] != null && LADDER.lh[fsStep] != null && LADDER.lh[lhStep] < LADDER.lh[fsStep]) {
        fail(`base.css:${lhDecl.line}  ${r.sel}  —— 行高 ${lhStep}(${LADDER.lh[lhStep]}px) 小于字号 ${fsStep} 的配对 ${LADDER.lh[fsStep]}px`);
      }
    }
  }

  // 同族一致性：同一个类名（同一层级的同类元素）只能落在一个档位
  const byFamily = new Map();
  for (const u of radiusUse) {
    if (!byFamily.has(u.family)) byFamily.set(u.family, new Map());
    const m = byFamily.get(u.family);
    if (!m.has(u.token)) m.set(u.token, u.where);
  }
  for (const [family, tiers] of byFamily) {
    if (tiers.size > 1) {
      const detail = [...tiers.entries()].map(([t, w]) => `${t} @ ${w}`).join(" | ");
      fail(`同一元素半径不一致：${family} 同时出现 ${detail}`);
    }
  }

  // 交互态 / 悬停对比 / 阴影范围：本次审计的三类根因，落成常驻规则
  checkHoverContrast(cssText, fail);
  checkInteractiveState(cssText, rules, fail);
  checkShadowScope(rules, fail);

  // 豁免失效：清单里的条目必须仍能匹配到声明
  for (const e of exemptions) {
    if (!usedExemptions.has(e)) {
      fail(`豁免已失效：${e.selector} ${e.property}: ${e.value}（样式已改，请同步删除清单项）`);
    }
  }

  return { problems, bareCount, usedExemptions, rules, tokens, num };
}

// ---------- 命中区 ----------
function checkHitArea({ rules, tokens, num }, fail) {
  const effective = (sel) => {
    const out = {};
    const candidates = [sel, sel.replace(/^\.app--next /, "")];
    for (const r of rules) if (candidates.includes(r.sel)) for (const d of r.decls) out[d.prop] = d.value;
    return out;
  };
  const HIT = [
    ".app--next .rail-head .add", ".app--next .srow__x", ".app--next .qrow2 .qa",
    ".app--next .qhead2 .qb", ".app--next .dop", ".app--next .sb-toggle",
    ".app--next .topbar .iconbtn", ".app--next .crumb2 .cb", ".app--next .sbtab__x",
    ".app--next .drawer__x",
  ];
  const INLINE_HIT = [".app--next .termtab__close", ".termtab__close"];
  const min = num(tokens.get("--hit-min")) || 28;
  for (const sel of HIT) {
    const d = effective(sel);
    if (!d.width && !d["min-width"]) { fail(`命中区检查：${sel} 缺少宽度声明`); continue; }
    const w = num(d["min-width"] || d.width);
    const h = num(d["min-height"] || d.height);
    if (w != null && w < min) {
      const grown = effective(`${sel}::after`);
      const inset = grown.inset ? num(grown.inset) : null;
      if (inset == null || w + Math.abs(inset) * 2 < min) fail(`命中区检查：${sel} 宽 ${w} < ${min}，且没有 ::after 补足`);
    }
    if (h != null && h < min) {
      const grown = effective(`${sel}::after`);
      const inset = grown.inset ? num(grown.inset) : null;
      if (inset == null || h + Math.abs(inset) * 2 < min) fail(`命中区检查：${sel} 高 ${h} < ${min}，且没有 ::after 补足`);
    }
  }
  for (const sel of INLINE_HIT) {
    const d = effective(sel);
    if (!d.width || !d.height) continue;
    if (d.width !== d.height || num(d.width) < 16) fail(`次级命中区：${sel} 应为 ≥16×16 的方形，实际 ${d.width}/${d.height}`);
  }
}

// ---------- TSX 内联样式 ----------
function checkInline(fail) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist|\.git/.test(e.name)) walk(p); }
      else if (/\.tsx$/.test(e.name)) files.push(p);
    }
  };
  walk(resolve(root, "src"));
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    const rel = relative(root, f).replace(/\\/g, "/");
    for (const m of t.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      const body = m[1];
      const ln = t.slice(0, m.index).split("\n").length;
      for (const p of ["padding", "margin", "gap", "fontSize", "lineHeight", "borderRadius"]) {
        if (new RegExp(`${p}\\s*:\\s*["']?[\\d.]+(px|rem)`).test(body)) fail(`${rel}:${ln}  内联样式 ${p} 使用裸值，改用令牌或 class`);
      }
    }
  }
}

// ---------- 最小窗口下限 ----------
function checkWindowFloor(fail) {
  const confs = ["tauri.conf.json", "tauri.windows.conf.json", "tauri.macos.conf.json", "tauri.linux.conf.json"];
  let checked = 0;
  for (const name of confs) {
    const file = resolve(root, "src-tauri", name);
    if (!existsSync(file)) {
      if (name === "tauri.conf.json") fail(`缺少窗口配置：${relative(root, file)}`);
      continue;
    }
    const conf = JSON.parse(readFileSync(file, "utf8"));
    const win = conf?.app?.windows?.[0];
    if (!win || win.minWidth == null) continue;
    checked += 1;
    const w = Number(win.minWidth);
    const h = Number(win.minHeight);
    if (w !== MIN_WINDOW.width || h !== MIN_WINDOW.height) {
      fail(
        `${name} 最小窗口必须是 ${MIN_WINDOW.width}×${MIN_WINDOW.height}（当前 ${w}×${h}）：` +
          `更窄没有布局模型，规范 §11 的窄窗档依赖这个下限不可达`,
      );
    }
  }
  if (!checked) fail("没有任何配置文件声明最小窗口");
  return { w: MIN_WINDOW.width, h: MIN_WINDOW.height, files: checked };
}

// ---------- 悬停对比度 ----------
// 规则：--state-hover / --state-hover-row 对所在底色必须 ≥ HOVER_MIN（WCAG 对比度）。
// 反例（本次审计抓到）：亮色用 #fafbfc 对白底 1.04:1，肉眼等于没有 hover；暗色则比行底更深。
function parseBlockVars(cssText, re) {
  const m = cssText.match(re);
  const out = new Map();
  if (!m) return out;
  for (const d of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(d[1], d[2].trim());
  return out;
}

function resolveVar(map, value, depth = 0) {
  if (depth > 6) return String(value);
  const ref = String(value).trim().match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref && map.has(ref[1])) return resolveVar(map, map.get(ref[1]), depth + 1);
  return String(value).trim();
}

function relLum(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

function checkHoverContrast(cssText, fail) {
  const themes = [
    { name: "dark", re: /:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\}/ },
    { name: "light", re: /\[data-theme="light"\]\s*\{([\s\S]*?)\}/ },
  ];
  const blocks = themes.map((t) => ({ name: t.name, vars: parseBlockVars(cssText, t.re) }));
  if (blocks.some((b) => !b.vars.size)) return; // 片段/负向用例没有主题块时跳过
  for (const { name, vars } of blocks) {
    const pairs = [
      ["--state-hover-row", "--surface"],
      ["--state-hover", "--surface-2"],
    ];
    for (const [fg, bg] of pairs) {
      const a = resolveVar(vars, vars.get(fg) ?? "");
      const b = resolveVar(vars, vars.get(bg) ?? "");
      if (!HEX.test(a) || !HEX.test(b)) {
        fail(`base.css:1  ${name}  —— ${fg}(${a}) / ${bg}(${b}) 不是十六进制，无法核算悬停对比度`);
        continue;
      }
      const ratio = contrastRatio(a, b);
      if (ratio < HOVER_MIN) {
        fail(
          `base.css:1  ${name}  —— 悬停对比度不足：${fg}(${a}) 对 ${bg}(${b}) 仅 ${ratio.toFixed(3)}:1，` +
            `要求 ≥ ${HOVER_MIN}:1（亮色要看得见、暗色不得变深）`,
        );
      }
    }
  }
}

// ---------- 交互三态 ----------
// 规则：所有 cursor:pointer 的元素必须有 :hover（自身或祖先/父级块），
// 按钮类还要有 :active；全局必须存在 :focus-visible 兜底。
const ACTIVE_REQUIRED_RE = /(btn|pill|tab|add|qb|ib|dop|cb|toggle|iconbtn|abtn)$/;

function checkInteractiveState(cssText, rules, fail) {
  // 全局兜底也算数：一条 :where(button…) 规则可以覆盖所有原生按钮
  const hasGlobalState = (state) =>
    [...cssText.matchAll(/([^{}]*)\{[^{}]*\}/g)].some(
      (m) => m[1].includes(`:${state}`) && /\bbutton\b|\[role="button"\]/.test(m[1]),
    );
  if (!hasGlobalState("focus-visible")) {
    fail("base.css:1  全局  —— 缺少 :focus-visible 兜底（button/a/input/[tabindex] 键盘不可见）");
  }
  const globalActive = hasGlobalState("active");

  const hasState = (base, state) => rules.some((r) => r.sel.startsWith(`${base}:${state}`));
  const seen = new Set();
  for (const r of rules) {
    if (!r.decls.some((d) => d.prop === "cursor" && d.value === "pointer")) continue;
    if (/:(hover|active|focus|disabled|checked)\b/.test(r.sel)) continue;
    if (seen.has(r.sel)) continue;
    seen.add(r.sel);
    const base = r.sel;
    const parentBlock = base.replace(/__[A-Za-z0-9-]+$/, "");
    const ancestorHover =
      base.split(" ").slice(0, -1).some((part) => part && hasState(part, "hover")) ||
      (parentBlock !== base && hasState(parentBlock, "hover"));
    if (!hasState(base, "hover") && !ancestorHover) {
      fail(`base.css:${r.line}  ${base}  —— 可点击但缺少 :hover（视觉上"点了才知道能点"）`);
    }
    if (ACTIVE_REQUIRED_RE.test(base) && !hasState(base, "active") && !globalActive) {
      fail(`base.css:${r.line}  ${base}  —— 按钮类缺少 :active（没有按压反馈）`);
    }
  }
}

// ---------- 阴影范围 ----------
// 规则：shadow-2 / shadow-3 只允许浮层（弹窗、抽屉、菜单、提示）使用；
// 页面内卡片用 1px 边表达层级，否则就是"卡中卡"。
const FLOATING_RE =
  /(modal|dialog|conflict__card|paste-guard__card|confdlg2|tray-toast|drawer|ctxmenu|rail|menu|popover|tooltip|toast|popup|overlay|sheet)/;

function checkShadowScope(rules, fail) {
  for (const r of rules) {
    if (/^(from|to|\d+(\.\d+)?%)$/.test(r.sel)) continue; // keyframes
    const d = r.decls.find((x) => x.prop === "box-shadow" && /var\(--shadow-[23]\)/.test(x.value));
    if (!d) continue;
    if (!FLOATING_RE.test(r.sel)) {
      fail(`base.css:${d.line}  ${r.sel}  —— 非浮层不得用 shadow-2/3（卡中卡），页面内卡片请只留 1px 边`);
    }
  }
}

// ---------- 负向自检 ----------
function selfTest() {
  const cases = [
    { name: "间距 padding", css: ".x { padding: 7px; }", expect: "裸 px" },
    { name: "字号", css: ".x { font-size: 13.5px; }", expect: "字号必须取自" },
    { name: "行高", css: ".x { font-size: var(--fs-md); line-height: 12px; }", expect: "行高必须取自" },
    { name: "圆角", css: ".x { border-radius: 9px; }", expect: "圆角必须取自" },
    { name: "描边", css: ".x { border: 2px solid var(--border); }", expect: "描边宽度必须取自" },
    { name: "控件高度", css: ".dop { height: 26px; }", expect: "控件尺寸必须取自" },
    { name: "图标尺寸", css: ".x .ic { width: 13px; height: 13px; }", expect: "图标尺寸必须取自" },
    { name: "状态色", css: ".x:hover { background: #1b2836; }", expect: "悬停色必须取自" },
    { name: "动效时长", css: ".x { transition: opacity 140ms ease; }", expect: "时长必须取自" },
    { name: "布局宽高", css: ".x { width: 333px; }", expect: "未令牌化且未登记豁免" },
    { name: "正文 10px", css: ".prose { font-size: var(--fs-2xs); }", expect: "正文/可读标签不得低于 12px" },
    { name: "正文 11px", css: ".prose { font-size: var(--fs-xs); }", expect: "正文/可读标签不得低于 12px" },
    { name: "越档字号", css: ".x { font-size: var(--fs-3xl); }", expect: "不在 6 档阶梯内" },
    { name: "越档圆角", css: ".x { border-radius: var(--r-sm); }", expect: "圆角只有 4 档" },
    { name: "控件用卡片档", css: ".iconbtn { border-radius: var(--r-card); }", expect: "控件类 iconbtn" },
    { name: "容器用控件档", css: ".modal { border-radius: var(--r-control); }", expect: "容器类 modal 必须用" },
    {
      name: "同族不一致",
      css: ".srow { border-radius: var(--r-control); }\n.app--next .srow { border-radius: var(--r-card); }",
      expect: "同一元素半径不一致：srow",
    },
    // ---- 本次质感审计的三类根因（负向用例必须被抓到） ----
    { name: "缺悬停", css: ".navpill { cursor: pointer; }", expect: "可点击但缺少 :hover" },
    {
      name: "缺按压",
      css: ".navpill { cursor: pointer; }\n.navpill:hover { background: var(--state-hover); }",
      expect: "按钮类缺少 :active",
    },
    {
      name: "悬停对比",
      css:
        ':root, [data-theme="dark"] { --surface: #111821; --surface-2: #0d131a; --state-hover: #131b24; --state-hover-row: #131b24; }\n' +
        '[data-theme="light"] { --surface: #ffffff; --surface-2: #fafbfc; --state-hover: #fafbfc; --state-hover-row: #fafbfc; }',
      expect: "悬停对比度不足",
    },
    { name: "卡片投影", css: ".termcard { box-shadow: var(--shadow-2); }", expect: "非浮层不得用 shadow-2/3" },
  ];
  const clean =
    ":where(button, [tabindex]):focus-visible { outline: var(--bw-2) solid var(--accent); }\n" +
    ".x { padding: var(--sp-2); font-size: var(--fs-md); line-height: var(--lh-md); }\n" +
    ".x .count { font-size: var(--fs-2xs); }\n" +
    ".srow .nm { font-size: var(--fs-list); line-height: var(--lh-sm); }";
  let ok = 0;
  console.log("负向自检：每类违规必须被捕获并指出位置");
  for (const c of cases) {
    const { problems } = analyze(c.css, { withTokens: false, exemptions: [] });
    const hit = problems.find((p) => p.includes(c.expect));
    if (hit && /base\.css:\d+/.test(hit)) {
      ok += 1;
      console.log(`  PASS  ${c.name.padEnd(8)} → ${hit}`);
    } else {
      console.log(`  FAIL  ${c.name.padEnd(8)} → 未捕获，实际：${problems.join(" | ") || "无"}`);
    }
  }
  const cleanProblems = analyze(clean, { withTokens: false, exemptions: [] }).problems;
  if (cleanProblems.length) {
    console.log(`  FAIL  合规样例 → 误报：${cleanProblems.join(" | ")}`);
  } else {
    ok += 1;
    console.log("  PASS  合规样例 → 0 条报告（含计数用 10px）");
  }
  const total = cases.length + 1;
  if (ok !== total) {
    console.error(`负向自检失败：${ok}/${total} 通过`);
    process.exit(1);
  }
  console.log(`负向自检通过：${ok}/${total}（${cases.length} 类违规 + 1 条合规对照）`);
}

// ---------- 主流程 ----------
if (SELF_TEST) {
  selfTest();
} else {
  const exemptions = loadExemptions();
  const css = readFileSync(cssPath, "utf8");
  const result = analyze(css, { exemptions });
  const problems = [...result.problems];
  checkHitArea(result, (m) => problems.push(m));
  checkInline((m) => problems.push(m));
  const win = checkWindowFloor((m) => problems.push(m));

  if (problems.length) {
    console.error(`界面规范检查失败：${problems.length} 条`);
    for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
    if (problems.length > 60) console.error(`  ... 其余 ${problems.length - 60} 条省略`);
    process.exit(1);
  }

  const tokenRefs = (css.match(/var\(--(fs|lh|r|ctl|icon|box|dur|isw|bw|state)-/g) || []).length;
  const exempt = result.usedExemptions.size;
  console.log(
    `界面规范检查通过：字号 6 档（下限 10px，正文 ≥12px）/ 行高 6 组 + 3 特殊 / 圆角 4 档（卡片 8 / 控件 6 / 胶囊 / 全圆）/ 控件高 10 档 / 图标 6 档`,
  );
  console.log(`最小窗口 ${win.w}×${win.h}（更窄无布局模型，矩阵不设该档）`);
  console.log(`令牌引用 ${tokenRefs} 处 / 裸值 ${result.bareCount - exempt} 处 / 豁免 ${exempt} 处`);
  console.log(`豁免清单（docs/design/ui-spec-exemptions.json，共 ${exemptions.length} 条）：`);
  exemptions.forEach((e, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${e.selector}  ${e.property}: ${e.value}  理由：${e.reason}  豁免人：${e.owner}`);
  });
}
