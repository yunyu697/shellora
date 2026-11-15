// 圆角一致性验收（纯 headless，不上屏）：
//
//   node scripts/radius-audit.mjs            # 自起 vite + headless Chrome，跑完自己关
//   node scripts/radius-audit.mjs --out .screenshots/radius
//
// 检查三件事：
//   1) 计算值只能落在 4 档（8 卡片 / 6 控件 / 胶囊 / 50% 正圆），出现别的值即「越档」；
//   2) 同一个选择器在不同视图 / 不同 DPI 下半径必须一致（同一软件不同界面表现不同就是这么来的）；
//   3) 每个圆角外侧 4 CSS px 的「角袋」里不能被画上比父层更亮的东西（1px 浅描边、阴影扩散、
//      子元素背景溢出、alpha 预乘白边都会落在这里）——截 12x/16x 放大图并做像素统计。
//
// 退出码：发现越档 / 跨视图不一致 / 角袋发亮时返回 1。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const ASCALE = 12; // 1x 下放大 12 倍；2x 下 8×2=16 倍
const DUMP = args.includes("--dump"); // 只导出「选择器 → 计算值」清单，不截图
const OUT = resolve(ROOT, argOf("--out", ".screenshots/radius"));
const VITE_PORT = Number(argOf("--port", 1523));
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const DPRS = [1, 2];

/* ------------------------------------------------------------------ CDP 客户端 */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
  once(method, sessionId, timeoutMs = 20000) {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        fail(new Error(`等待 ${method} 超时`));
      }, timeoutMs);
      const fn = (msg) => {
        if (msg.method !== method) return;
        if (sessionId && msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(fn);
        ok(msg.params);
      };
      this.listeners.add(fn);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error(`等待 ${url} 超时`);
}

/* --------------------------------------------------------------- 页面内探针 */

// 枚举所有可见的、带圆角的元素；radius 归一成四角数值，便于跨视图比对。
const CENSUS = String.raw`
(() => {
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const name = (el) => {
    const cls = (el.className || "").toString().trim().split(/\s+/).filter(Boolean);
    return el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
  };
  const corners = (s) => {
    const v = (s || "").match(/[-\d.]+(%|px)/g) || [];
    if (!v.length) return null;
    const n = v.map((x) => (x.endsWith("%") ? x : Math.round(parseFloat(x) * 100) / 100 + "px"));
    const [tl, tr, br, bl] = n.length === 1 ? [n[0], n[0], n[0], n[0]]
      : n.length === 2 ? [n[0], n[1], n[0], n[1]]
      : n.length === 3 ? [n[0], n[1], n[2], n[1]]
      : n;
    return [tl, tr, br, bl];
  };
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const c = corners(cs.borderRadius);
    if (!c || c.every((x) => x === "0px")) continue;
    const r = el.getBoundingClientRect();
    out.push({
      sel: name(el),
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join(" "),
      c,
      radius: cs.borderRadius,
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.x),
      y: Math.round(r.y),
      bg: cs.backgroundColor,
      border: cs.borderTopWidth === "0px" ? null : cs.borderTopWidth + " " + cs.borderTopColor,
      shadow: cs.boxShadow === "none" ? null : cs.boxShadow,
      clip: cs.overflow !== "visible",
    });
  }
  return out;
})()
`;

// 取某个元素某个角的放大截图并做像素统计：角袋（元素框外 4 CSS px 的三角区）里应该只有父层底色。
const PIXELS = (dataUrl, boxSize) => String.raw`
((dpr) => new Promise((ok) => {
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const px = img.width / ${boxSize}; // 每 CSS px 占多少图像像素
    const band = Math.round(px * 4); // 元素框外 4 CSS px 的角袋
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const lum = (r, g, b) => {
      const f = [r, g, b].map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    };
    let max = 0, maxHex = "000000", sum = 0, n = 0;
    const hist = new Map();
    for (let y = 0; y < band; y++) {
      for (let x = 0; x < band; x++) {
        const i = (y * img.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const L = lum(r, g, b);
        sum += L;
        n++;
        const hex = ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
        hist.set(hex, (hist.get(hex) || 0) + 1);
        if (L > max) { max = L; maxHex = hex; }
      }
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    ok({ maxLum: Math.round(max * 255), maxHex, meanLum: Math.round((sum / n) * 255), top });
  };
  img.onerror = () => ok(null);
  img.src = ${JSON.stringify(dataUrl)};
}))(window.devicePixelRatio)
`;

/* ----------------------------------------------------------------- 视角夹具 */

const VIEWS = [
  {
    id: "main",
    url: "/?preview=1&locale=zh-CN",
    ready: ".topbar",
    prep: `(() => { const b = document.querySelector('.rail-toggle'); if (b && b.getAttribute('aria-pressed') === 'true') b.click(); })()`,
  },
  {
    id: "files",
    url: "/?preview=1&locale=zh-CN",
    ready: ".files",
    prep: `window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',code:'KeyE',ctrlKey:true,shiftKey:true,bubbles:true}))`,
  },
  {
    id: "queue",
    url: "/?preview=1&locale=zh-CN",
    ready: ".files",
    prep: `window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',code:'KeyE',ctrlKey:true,shiftKey:true,bubbles:true}));`,
    after: `(() => { const b = document.querySelector('.qhead2 .qb[aria-expanded="false"]'); if (b) b.click(); })()`,
  },
  { id: "connect", url: "/?preview=1&locale=zh-CN&view=connect", ready: ".connpage", prep: `(() => {})()` },
  { id: "settings", url: "/?preview=1&locale=zh-CN&panel=settings", ready: ".settings-card", prep: `(() => {})()` },
];

// 4 档的合法计算值：卡片 8 / 控件 6 / 胶囊 ≥999 / 正圆 50%
const THEMES = ["light", "dark"];

function tierOf(c) {
  const first = c[0];
  if (first.endsWith("%")) return first === "50%" ? "full" : `bad:${first}`;
  const v = parseFloat(first);
  if (v === 8) return "card";
  if (v === 6) return "control";
  if (v >= 999) return "pill";
  return `bad:${first}`;
}

/* ------------------------------------------------------------------- 主流程 */

const findings = { badTier: [], crossView: [], fringe: [] };
const rows = [];
const dumpMap = new Map(); // sel -> { radius, groups:Set }

function dumpNote(sel, radius, group) {
  if (!DUMP) return;
  const rec = dumpMap.get(sel) ?? { radius, groups: new Set() };
  rec.groups.add(group);
  dumpMap.set(sel, rec);
}

async function captureCorner(S, cdp, sessionId, el, dpr, tag) {
  // 裁剪：元素框左上角外扩 4 CSS px，取 16x16 的角部窗口
  const clip = { x: el.x - 4, y: el.y - 4, width: 16, height: 16, scale: ASCALE };
  const shot = await S("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
  const file = join(OUT, `${tag}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  const probe = await S("Runtime.evaluate", {
    expression: PIXELS(`data:image/png;base64,${shot.data}`, 16),
    returnByValue: true,
    awaitPromise: true,
  });
  return { file, pix: probe.result.value };
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // 1) vite（headless 静态服务即可，但我们复用 ?preview=1 夹具，需要 dev server）
  const viteBin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) throw new Error("未找到 vite，请先 pnpm install");
  const vite = spawn(process.execPath, [viteBin, "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: "ignore",
    windowsHide: true,
  });

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const chrome = candidates.find((p) => existsSync(p));
  if (!chrome) throw new Error("未找到 Chrome / Edge");
  const profile = join(tmpdir(), `shellora-radius-${Date.now()}`);
  const dbgPort = 9411 + Math.floor(Math.random() * 40);
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${dbgPort}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  try {
    await waitFor(`${BASE}/`);
    await waitFor(`http://127.0.0.1:${dbgPort}/json/version`);
    const info = await (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = fail;
    });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    await S("Page.enable");
    await S("Runtime.enable");

    for (const theme of THEMES) {
      for (const dpr of DPRS) {
        for (const view of VIEWS) {
          // 主题与会话栏状态在每个文档加载前钉死，避免上一次交互残留导致 1x/2x 不可比
          const { identifier } = await S("Page.addScriptToEvaluateOnNewDocument", {
            source: `try { localStorage.setItem('shellora.uiTheme', '${theme}'); localStorage.setItem('shellora.railCollapsed', '0'); } catch (e) {}`,
          });
          await S("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false });
          const loaded = cdp.once("Page.loadEventFired", sessionId);
          await S("Page.navigate", { url: BASE + view.url });
          await loaded;
          for (let i = 0; i < 80; i++) {
            const r = await S("Runtime.evaluate", {
              expression: `document.querySelector('${view.ready}') ? 1 : 0`,
              returnByValue: true,
            });
            if (r.result.value === 1) break;
            await sleep(120);
          }
          await S("Runtime.evaluate", { expression: view.prep });
          await sleep(500);
          if (view.after) {
            await S("Runtime.evaluate", { expression: view.after });
            await sleep(500);
          }
          // 会话栏必须展开：折叠与否会改变参与测量的元素集合，必须钉死
          for (let i = 0; i < 10; i++) {
            const r = await S("Runtime.evaluate", {
              expression: `(() => { const b = document.querySelector('.rail-toggle'); if (b && b.getAttribute('aria-pressed') === 'true') { b.click(); return 0; } return document.querySelector('.rail') ? 1 : 0; })()`,
              returnByValue: true,
            });
            if (r.result.value === 1) break;
            await sleep(250);
          }
          // 关掉过渡动画，保证截图落在稳定帧上
          await S("Runtime.evaluate", {
            expression: `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}'; document.head.appendChild(s); })()`,
          });
          await sleep(250);

          const census = (await S("Runtime.evaluate", { expression: CENSUS, returnByValue: true })).result.value;

          // 2) 档位与跨视图一致性
          const byTier = {};
          const seenSel = new Map();
          for (const el of census) {
            const t = tierOf(el.c);
            byTier[t] = (byTier[t] || 0) + 1;
            if (t.startsWith("bad")) findings.badTier.push({ view: view.id, dpr, theme, sel: el.sel, radius: el.radius });
            const prior = seenSel.get(el.sel);
            const where = `${view.id}@${dpr}x`;
            if (prior === undefined) seenSel.set(el.sel, el.radius);
            else if (prior !== el.radius) findings.crossView.push({ sel: el.sel, a: prior, b: el.radius, where });
          }
          rows.push({ view: view.id, dpr, theme, total: census.length, tiers: byTier });
          for (const el of census) dumpNote(el.sel, el.radius, `${view.id}@${dpr}x/${theme}`);

          // 3) 角部放大 + 像素
          if (!DUMP) {
          const picked = [];
          for (const tier of ["card", "control", "pill"]) {
            const list = census
              .filter((e) => tierOf(e.c) === tier && e.w >= 28 && e.h >= 18 && e.x >= 6 && e.y >= 6)
              .sort((a, b) => b.w * b.h - a.w * a.h);
            for (const el of list.slice(0, 2)) picked.push({ el, tier });
          }
          for (const { el, tier } of picked) {
            const tag = `${view.id}@${dpr}x-${theme}-${tier}-${el.sel.replace(/[^\w-]/g, "_")}-${el.w}x${el.h}`;
            const { file, pix } = await captureCorner(S, cdp, sessionId, el, dpr, tag);
            if (!pix) continue;
            // 角袋（元素框外 4 CSS px）应只有父层底色；明显高于均值的亮斑才算白边/浅描边
            const rec = { view: view.id, dpr, theme, tier, sel: el.sel, file, ...pix, shadow: Boolean(el.shadow), bg: el.bg };
            rows.push({ corner: rec });
            if (!el.shadow && pix.maxLum > pix.meanLum + 12) findings.fringe.push(rec);
          }
          }
          await S("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        }
      }
    }
  } finally {
    proc.kill();
    vite.kill();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows 偶发占用 */
    }
  }

  /* --------------------------------------------------------------- 输出 */

  const label = { card: "卡片 8", control: "控件 6", pill: "胶囊 999", full: "全圆 50%" };
  for (const r of rows.filter((x) => x.view)) {
    const t = Object.entries(r.tiers)
      .map(([k, v]) => `${label[k] || k}×${v}`)
      .join(" / ");
    console.log(`${r.view.padEnd(8)} ${r.dpr}x ${r.theme.padEnd(5)} ${String(r.total).padStart(3)} 个圆角元素   ${t}`);
  }
  console.log("\n角部放大（12 倍 CSS px）：");
  for (const r of rows.filter((x) => x.corner)) {
    const c = r.corner;
    const flag = findings.fringe.includes(c) ? "  ← 角袋发亮" : "";
    console.log(
      `  ${c.view}@${c.dpr}x/${c.theme} ${c.tier.padEnd(7)} ${c.sel.padEnd(24)} 角袋 max ${String(c.maxLum).padStart(3)} ` +
        `(${c.maxHex}) / mean ${String(c.meanLum).padStart(3)}${c.shadow ? "  [含阴影]" : ""}${flag}`,
    );
  }

  if (DUMP) {
    console.log("\n选择器\t计算值\t出现组数\t示例组");
    for (const [sel, rec] of [...dumpMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`${sel}\t${rec.radius}\t${rec.groups.size}\t${[...rec.groups][0]}`);
    }
    process.exit(findings.badTier.length || findings.crossView.length ? 1 : 0);
  }

  let code = 0;
  if (findings.badTier.length) {
    code = 1;
    console.log("\n越档圆角：");
    for (const f of findings.badTier.slice(0, 20)) console.log(`  ! ${f.view}@${f.dpr}x/${f.theme} ${f.sel} → ${f.radius}`);
  }
  if (findings.crossView.length) {
    code = 1;
    console.log("\n跨视图/跨 DPI 不一致：");
    for (const f of findings.crossView.slice(0, 20)) console.log(`  ! ${f.sel} ${f.a} vs ${f.b}（${f.where}）`);
  }
  if (findings.fringe.length) {
    code = 1;
    console.log("\n角袋发亮（疑似白边/浅描边）：");
    for (const f of findings.fringe.slice(0, 20)) console.log(`  ! ${f.view}@${f.dpr}x/${f.theme} ${f.sel} max ${f.maxLum} (${f.maxHex})`);
  }
  console.log(`\n放大图 → ${OUT}`);
  if (!code) console.log("圆角验收：4 档内 / 跨视图一致 / 角袋无发亮");
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
