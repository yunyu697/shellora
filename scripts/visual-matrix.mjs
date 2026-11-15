// 五语种 × 视口矩阵的视觉回归：不引入 Playwright，直接用本机 Chrome/Edge 的 CDP。
//
//   pnpm dev                 # 先起 1420 端口（?preview=1 夹具由 src/lib/ipc/preview.ts 提供）
//   node scripts/visual-matrix.mjs --out docs/design/shots
//
// 每次运行会：
//   1) 固定语种（?locale=）打开预览，展开左栏；
//   2) 用 CDP 的 Emulation 设定精确视口与 devicePixelRatio（200% DPI 用 444×297@2x 模拟）；
//   3) 逐区域截图（顶栏 / 左栏 / 文件表格 / 队列 / 设置页）；
//   4) 在页面内测量：横向溢出、文本截断、行高挤压、按钮被文案撑破、实际字号分布、文本对比度。
//
// 退出码：发现「无 title 的截断 / 溢出 / 挤压 / 对比度 < 4.5（小字号）」时返回 1，可直接进 CI。

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = argOf("--url", "http://localhost:1420");
const OUT = resolve(argOf("--out", "docs/design/shots"));

const LOCALES = ["zh-CN", "zh-TW", "en", "ja", "es"];
// 100%：最小窗口 / 常用窗口；200%：同一 CSS 视口在 2 倍 DPI 下，字号物理像素翻倍（验证“不靠反缩放”）。
// 640×480 是 tauri.conf.json 的最小窗口下限，更窄的 444×297 不再设档（布局模型不支持）。
const VIEWPORTS = [
  { id: "1440x900@1x", width: 1440, height: 900, dpr: 1 },
  { id: "887x593@1x", width: 887, height: 593, dpr: 1 },
  { id: "887x593@2x", width: 887, height: 593, dpr: 2 },
  { id: "640x480@1x", width: 640, height: 480, dpr: 1 },
];

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error("未找到 Chrome / Edge，无法执行视觉矩阵");
  process.exit(2);
}

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
  once(method, sessionId, timeoutMs = 15000) {
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

async function waitForHttp(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待 ${url} 超时`);
}

/* --------------------------------------------------------------- 页面内探针 */

// 被注入页面的函数：收集布局问题。所有测量都在 CSS px 下，与 devicePixelRatio 无关。
const PROBE = String.raw`
(() => {
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const path = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; i < 4 && n && n.nodeType === 1; i++) {
      const cls = (n.className || "").toString().trim().split(/\s+/).filter(Boolean)[0];
      parts.unshift(n.tagName.toLowerCase() + (cls ? "." + cls : ""));
      n = n.parentElement;
    }
    return parts.join(">");
  };
  const parse = (s) => {
    const m = (s || "").match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : null;
  };
  const lum = (c) => {
    const f = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(bg)) {
        const c = parse(bg);
        if (c) return c;
      }
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
  };
  const scrollable = (el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) return true;
      n = n.parentElement;
    }
    return false;
  };
  // 最近一个会裁切内容的祖先（overflow 非 visible，或自己声明了省略号）
  const clipper = (el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      if (cs.overflowX !== "visible" || cs.textOverflow === "ellipsis") return n;
      n = n.parentElement;
    }
    return null;
  };
  // Range 能测到 inline 元素的真实文字宽度，scrollWidth 对 inline 恒为 0
  const textRect = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return r;
  };
  const hasTitle = (el, stop) => {
    let n = el;
    while (n && n !== stop && n !== document.body) {
      if (n.getAttribute && n.getAttribute("title")) return true;
      n = n.parentElement;
    }
    return Boolean(stop && stop.getAttribute && stop.getAttribute("title"));
  };

  const out = {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    overflow: [],
    clipped: [],
    squeezed: [],
    fonts: {},
    contrast: [],
    regions: {},
    rootFont: getComputedStyle(document.documentElement).fontSize,
    bodyFont: getComputedStyle(document.body).fontSize,
  };

  for (const sel of [".topbar", ".rail", ".files", ".queue2", ".settings-card", ".connpage", ".sessionbar--inline"]) {
    const el = document.querySelector(sel);
    if (!el || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    out.regions[sel] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    if (r.right > innerWidth + 1 || r.left < -1) {
      out.overflow.push({ sel, kind: "region", left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
    }
  }

  for (const el of document.querySelectorAll(".topbar *, .rail *, .settings-card *, .queue2 *")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 1) {
      let n = el, root = true;
      while (n && n !== document.body) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(n).overflowX)) { root = false; break; }
        n = n.parentElement;
      }
      if (root) out.overflow.push({ sel: path(el), kind: "text", right: Math.round(r.right) });
    }
  }

  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const text = (el.textContent || "").trim();
    if (!text || el.children.length) continue;
    const cs = getComputedStyle(el);
    const fs = Math.round(parseFloat(cs.fontSize) * 10) / 10;
    out.fonts[fs] = (out.fonts[fs] || 0) + 1;
    const t = textRect(el);
    const box = clipper(el);
    if (box && t.width > 0) {
      const b = box.getBoundingClientRect();
      if (t.right > b.right + 1 || t.left < b.left - 1) {
        out.clipped.push({
          sel: path(el),
          text: text.slice(0, 42),
          sw: Math.round(t.width),
          cw: Math.round(b.width),
          tl: Math.round(t.left),
          tr: Math.round(t.right),
          bl: Math.round(b.left),
          br: Math.round(b.right),
          ellipsis: getComputedStyle(box).textOverflow === "ellipsis",
          title: hasTitle(el, box),
          inScroll: scrollable(el),
        });
      }
    }
    if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0 && cs.overflowY === "hidden") {
      out.squeezed.push({ sel: path(el), text: text.slice(0, 42), sh: el.scrollHeight, ch: el.clientHeight });
    }
    const key = el.tagName + "|" + cs.color + "|" + fs;
    if (fs <= 12 && !seen.has(key)) {
      seen.add(key);
      out.contrast.push({
        sel: path(el),
        text: text.slice(0, 24),
        fs,
        fg: cs.color,
        bg: "rgb(" + bgOf(el).join(",") + ")",
        ratio: Math.round(ratio(parse(cs.color), bgOf(el)) * 100) / 100,
      });
    }
  }
  out.contrast.sort((a, b) => a.ratio - b.ratio);
  out.contrast = out.contrast.slice(0, 8);
  return out;
})()
`;

/* ------------------------------------------------------------------- 主流程 */

const shots = [];
const report = [];
// 「同一个矩形只落一个文件名」的断言结果，正常必须为 0
const dupAll = [];

function summarize(locale, vp, data) {
  // 滚动容器内的溢出可以滚动看到，不算截断；只统计真正被硬裁掉的文字
  const realClip = data.clipped.filter((c) => !c.title && !c.inScroll);
  const scrollClip = data.clipped.filter((c) => c.inScroll).length;
  const clippedWithTitle = data.clipped.filter((c) => c.title).length;
  const lowContrast = data.contrast.filter((c) => c.ratio < 4.5);
  return {
    locale,
    vp: vp.id,
    overflow: data.pageOverflowX,
    overflowing: data.overflow.length,
    clipped: data.clipped.length,
    clippedNoTitle: realClip.length,
    clippedTitle: clippedWithTitle,
    scrollClip,
    squeezed: data.squeezed.length,
    minFont: Math.min(...Object.keys(data.fonts).map(Number)),
    fontHist: Object.keys(data.fonts)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => `${k}px×${data.fonts[k]}`)
      .join(" "),
    lowContrast: lowContrast.length,
    details: { realClip, overflow: data.overflow, squeezed: data.squeezed, lowContrast, data },
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const profile = join(tmpdir(), `shellora-matrix-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const port = 9333 + Math.floor(Math.random() * 40);
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForHttp(`http://127.0.0.1:${port}/json/version`);
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
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

    for (const vp of VIEWPORTS) {
      for (const locale of LOCALES) {
        // 每个 locale×视口 单独一套登记表：1x 与 2x 的 CSS 矩形完全相同，共用会被误判成重复
        const rectSeen = new Map(); // "x,y,wxh" -> 文件名
        const fullSeen = new Map(); // 整窗图：文件名 -> base64，按字节判重
        const dupLocal = [];
        await S("Emulation.setDeviceMetricsOverride", {
          width: vp.width,
          height: vp.height,
          deviceScaleFactor: vp.dpr,
          mobile: false,
        });
        const url = `${BASE}/?preview=1&locale=${locale}`;
        const loaded = cdp.once("Page.loadEventFired", sessionId);
        await S("Page.navigate", { url });
        await loaded;

        // 等应用挂载 + 夹具渲染（文件表、队列都要在）
        for (let i = 0; i < 60; i++) {
          const { result } = await S("Runtime.evaluate", {
            expression: `document.querySelector('.topbar') && document.querySelector('.queue2') ? 1 : 0`,
            returnByValue: true,
          });
          if (result.value === 1) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        // 展开左栏（默认收起），等过渡结束
        await S("Runtime.evaluate", {
          expression: `(() => { const b = document.querySelector('.rail-toggle'); if (b && b.getAttribute('aria-pressed') === 'true') b.click(); })()`,
        });
        await new Promise((r) => setTimeout(r, 600));

        const { result } = await S("Runtime.evaluate", { expression: PROBE, returnByValue: true, awaitPromise: false });
        const data = result.value;

        // 整窗 + 分区截图
        const full = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const write = (name, b64) => {
          const file = join(OUT, name);
          writeFileSync(file, Buffer.from(b64, "base64"));
          shots.push(file);
        };
        // 整窗图：状态没变化时字节相同，只留第一张，避免 main/panel/queue 三份同图
        const writeFull = (name, b64) => {
          for (const [prevName, prevB64] of fullSeen) {
            if (prevB64 === b64) {
              console.log(`  · 跳过 ${name}：与 ${prevName} 字节相同（该状态无视觉变化）`);
              return;
            }
          }
          fullSeen.set(name, b64);
          write(name, b64);
        };
        // 分区图：同一个元素矩形只落一个文件名；两个选择器命中同一块区域时判失败
        const writeRegion = async (name, clip) => {
          const key = `${clip.x},${clip.y},${clip.width}x${clip.height}`;
          const prev = rectSeen.get(key);
          if (prev) {
            dupLocal.push({ rect: key, first: prev, dup: name });
            return;
          }
          rectSeen.set(key, name);
          write(name, (await S("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false })).data);
        };
        writeFull(`${locale}-${vp.id}-main.png`, full.data);
        for (const [name, box] of Object.entries(data.regions)) {
          if (name === ".settings-card") continue;
          const w = Math.min(box.w, vp.width - Math.max(0, box.x));
          if (w <= 8 || box.h <= 8) continue;
          const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: w, height: Math.min(box.h, vp.height), scale: 1 };
          await writeRegion(`${locale}-${vp.id}-${name.replace(/^\./, "").replace(/[^\w-]/g, "_")}.png`, clip);
        }

        report.push(summarize(locale, vp, data));

        // 文件面板（Ctrl+Shift+E）：文件表格与传输队列都在这里
        await S("Runtime.evaluate", {
          expression: `window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',code:'KeyE',ctrlKey:true,shiftKey:true,bubbles:true}))`,
        });
        await new Promise((r) => setTimeout(r, 800));
        const pd = (await S("Runtime.evaluate", { expression: PROBE, returnByValue: true })).result.value;
        writeFull(`${locale}-${vp.id}-panel.png`, (await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data);
        for (const name of [".files", ".queue2"]) {
          const box = pd.regions[name];
          if (!box || box.w <= 8 || box.h <= 8) continue;
          const clip = {
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: Math.min(box.w, vp.width - Math.max(0, box.x)),
            height: Math.min(box.h, vp.height - Math.max(0, box.y)),
            scale: 1,
          };
          if (clip.width <= 8 || clip.height <= 8) continue;
          await writeRegion(`${locale}-${vp.id}-panel-${name.replace(/^\./, "")}.png`, clip);
        }
        report.push({ ...summarize(locale, vp, pd), panel: true });

        // 队列：展开文件面板底部的传输队列，单独成一档
        await S("Runtime.evaluate", {
          expression: `(() => { const b = document.querySelector('.qhead2 .qb[aria-expanded="false"]'); if (b) b.click(); })()`,
        });
        await new Promise((r) => setTimeout(r, 500));
        const qd = (await S("Runtime.evaluate", { expression: PROBE, returnByValue: true })).result.value;
        // 这一档只保留探针数据：实测它与抽屉态视觉完全相同（5 语种 × 4 档 × 2 = 40 组字节相同），
        // 再落 queue.png / queue2.png 就是重复证据。若将来展开后真的出现视觉变化，writeFull 会自动留图。
        writeFull(`${locale}-${vp.id}-queue.png`, (await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data);
        report.push({ ...summarize(locale, vp, qd), queue: true });

        // 连接页（?view=connect）
        const loadedConn = cdp.once("Page.loadEventFired", sessionId);
        await S("Page.navigate", { url: `${BASE}/?preview=1&locale=${locale}&view=connect` });
        await loadedConn;
        for (let i = 0; i < 60; i++) {
          const r = await S("Runtime.evaluate", {
            expression: `document.querySelector('.connpage') ? 1 : 0`,
            returnByValue: true,
          });
          if (r.result.value === 1) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await S("Runtime.evaluate", {
          expression: `(() => { const b = document.querySelector('.rail-toggle'); if (b && b.getAttribute('aria-pressed') === 'true') b.click(); })()`,
        });
        await new Promise((r) => setTimeout(r, 600));
        const cn = (await S("Runtime.evaluate", { expression: PROBE, returnByValue: true })).result.value;
        writeFull(`${locale}-${vp.id}-connect.png`, (await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data);
        if (cn.regions[".connpage"]) {
          const box = cn.regions[".connpage"];
          const clip = {
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: Math.min(box.w, vp.width - Math.max(0, box.x)),
            height: Math.min(box.h, vp.height - Math.max(0, box.y)),
            scale: 1,
          };
          if (clip.width > 8 && clip.height > 8) await writeRegion(`${locale}-${vp.id}-connpage.png`, clip);
        }
        report.push({ ...summarize(locale, vp, cn), connect: true });

        // 设置页
        const loaded2 = cdp.once("Page.loadEventFired", sessionId);
        await S("Page.navigate", { url: `${BASE}/?preview=1&locale=${locale}&panel=settings` });
        await loaded2;
        // 设置入口在左栏底部：先等应用挂载，再展开左栏，TraySettings 才会读取 ?panel=settings
        for (let i = 0; i < 60; i++) {
          const r = await S("Runtime.evaluate", {
            expression: `document.querySelector('.rail-toggle') ? 1 : 0`,
            returnByValue: true,
          });
          if (r.result.value === 1) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await S("Runtime.evaluate", {
          expression: `(() => { const b = document.querySelector('.rail-toggle'); if (b && b.getAttribute('aria-pressed') === 'true') b.click(); })()`,
        });
        for (let i = 0; i < 60; i++) {
          const r = await S("Runtime.evaluate", {
            expression: `document.querySelector('.settings-card') ? 1 : 0`,
            returnByValue: true,
          });
          if (r.result.value === 1) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 400));
        const st = await S("Runtime.evaluate", { expression: PROBE, returnByValue: true });
        const stFull = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFull(`${locale}-${vp.id}-settings.png`, stFull.data);
        if (st.result.value.regions[".settings-card"]) {
          const box = st.result.value.regions[".settings-card"];
          const clip = {
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: Math.min(box.w, vp.width - Math.max(0, box.x)),
            height: Math.min(box.h, vp.height - Math.max(0, box.y)),
            scale: 1,
          };
          if (clip.width > 8 && clip.height > 8) await writeRegion(`${locale}-${vp.id}-settings-card.png`, clip);
        }
        report.push({ ...summarize(locale, vp, st.result.value), settings: true });
        dupAll.push(...dupLocal);
      }
    }
  } finally {
    proc.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  }

  // 控制台报告
  const bad = [];
  for (const r of report) {
    const tag = r.settings ? "设置页" : r.connect ? "连接页" : r.queue ? "队列  " : r.panel ? "文件面板" : "主界面";
    console.log(
      `${r.locale.padEnd(6)} ${r.vp.padEnd(12)} ${tag}  ` +
        `横向溢出 ${r.overflow}px / 越界元素 ${r.overflowing} / 截断 ${r.clipped}（无 title ${r.clippedNoTitle}，可滚动 ${r.scrollClip}） / ` +
        `纵向挤压 ${r.squeezed} / 最小字号 ${r.minFont}px / 低对比 ${r.lowContrast}`,
    );
    console.log(`        实际字号分布：${r.fontHist}`);
    if (r.minFont < 10) {
      console.log(`    ! 最小字号 ${r.minFont}px 低于 10px 下限（辅助字号已抬档，仍出现说明有未令牌化字号）`);
      bad.push(`${r.locale} ${r.vp} 最小字号 ${r.minFont}px`);
    }
    for (const c of r.details.realClip.slice(0, 6)) {
      console.log(
        `    ! 截断 ${c.sel} "${c.text}" 文字 ${c.tl}–${c.tr} / 容器 ${c.bl}–${c.br}${c.inScroll ? "（滚动容器内）" : ""}`,
      );
      bad.push(`${r.locale} ${r.vp} 截断 ${c.sel}`);
    }
    for (const o of r.details.overflow.slice(0, 6)) {
      console.log(`    ! 越界 ${o.sel} right=${o.right}`);
      bad.push(`${r.locale} ${r.vp} 越界 ${o.sel}`);
    }
    for (const s of r.details.squeezed.slice(0, 6)) {
      console.log(`    ! 挤压 ${s.sel} "${s.text}" ${s.sh}>${s.ch}`);
      bad.push(`${r.locale} ${r.vp} 挤压 ${s.sel}`);
    }
    for (const c of r.details.lowContrast) {
      console.log(`    ! 对比度 ${c.sel} ${c.fs}px ${c.ratio}:1  ${c.text}`);
      bad.push(`${r.locale} ${r.vp} 对比度 ${c.sel} ${c.ratio}`);
    }
  }
  console.log(`\n截图 ${shots.length} 张 → ${OUT}`);
  // 自检：不同选择器解析到同一个矩形时，只允许落一个文件名
  console.log(`同区域不同名 ${dupAll.length} 处`);
  for (const d of dupAll) {
    console.log(`    ! 同区域不同名 rect=${d.rect} 先落 ${d.first}，被跳过的 ${d.dup}`);
    bad.push(`${d.first} / ${d.dup} 命中同一矩形`);
  }
  if (bad.length) {
    console.log(`发现 ${bad.length} 处待修`);
    process.exit(1);
  }
  console.log("五语种 × 视口矩阵：无截断 / 无越界 / 无挤压 / 对比度达标 / 无重复截图");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
