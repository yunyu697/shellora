// 更新流程 UI 探针：通过 WebView2 CDP 驱动真实 Tauri 应用。
// 前置：node scripts/updater-sim.mjs 已在 8787 端口运行，应用使用 .updater-fixture/tauri.test.conf.json 构建。
// 用法：node scripts/updater-probe.mjs [cdpPort] [outDir]
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = Number(process.argv[2] ?? 9223);
const OUT = resolve(process.argv[3] ?? "docs/ui/updater");
const BAD = resolve(".updater-fixture/tamper.flag");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* WebView2 未就绪 */
    }
    await sleep(500);
  }
  throw new Error("CDP: 未找到 page target");
}

function createRpc(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`CDP websocket 失败: ${e?.message ?? "unknown"}`));
  });
  return {
    ws,
    opened,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function main() {
  if (existsSync(BAD)) unlinkSync(BAD);
  const target = await pickTarget();
  const rpc = createRpc(target.webSocketDebuggerUrl);
  await rpc.opened;
  await rpc.call("Page.enable");
  await rpc.call("Runtime.enable");

  const evalJs = async (expression) => {
    const res = await rpc.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(`JS 异常: ${res.exceptionDetails.text}`);
    return res.result?.value;
  };

  const waitFor = async (expr, timeoutMs, stepMs = 250) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await evalJs(expr)) return true;
      await sleep(stepMs);
    }
    return false;
  };

  const shot = async (name) => {
    const { data } = await rpc.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  };

  const timeline = [];
  const mark = (step, detail = {}) => {
    timeline.push({ t: new Date().toISOString(), step, ...detail });
    console.log(`[${step}] ${JSON.stringify(detail)}`);
  };

  if (!(await waitFor("!!document.querySelector('.upd-trigger')", 40_000))) {
    throw new Error("更新入口未挂载（应用未启动或页面未加载）");
  }
  await waitFor("!!document.querySelector('.upd-dot')", 20_000);
  const silentBadge = await evalJs("!!document.querySelector('.upd-dot')");
  mark("startup-silent-check", { badge: silentBadge });
  await shot("01-silent-badge");

  await evalJs("document.querySelector('.upd-trigger').click()");
  if (!(await waitFor("!!document.querySelector('.upd-card')", 10_000))) {
    throw new Error("更新面板未打开");
  }
  if (
    !(await waitFor(
      "!!document.querySelector('.upd-to') && document.querySelector('.upd-to').textContent.includes('1.0.3')",
      20_000,
    ))
  ) {
    throw new Error("未检测到新版本（检查 latest.json 与本地服务）");
  }
  const available = await evalJs(`({
    version: document.querySelector('.upd-to')?.textContent ?? '',
    from: document.querySelector('.upd-from')?.textContent ?? '',
    date: document.querySelector('.upd-date')?.textContent ?? '',
    size: document.querySelector('.upd-size')?.textContent?.trim() ?? '',
    notes: document.querySelector('.upd-notes pre')?.textContent ?? '',
    current: document.querySelector('.upd-title p')?.textContent ?? ''
  })`);
  mark("update-available", available);
  await shot("02-available");

  // 深色主题下同一面板的样式（沿用 02 主题令牌）。
  await evalJs(
    `[...document.querySelectorAll('.iconbtn')].find((b) => (b.title ?? '').includes('深色'))?.click()`,
  );
  await sleep(400);
  await shot("02b-available-dark");
  await evalJs(
    `[...document.querySelectorAll('.iconbtn')].find((b) => (b.title ?? '').includes('浅色'))?.click()`,
  );
  await sleep(300);

  await evalJs(
    `[...document.querySelectorAll('.upd-card .btn')].find((b) => b.textContent.includes('下载更新'))?.click()`,
  );
  await sleep(900);
  const progress = await evalJs(`({
    active: !!document.querySelector('.upd-progress'),
    percent: document.querySelector('.upd-progress')?.getAttribute('aria-valuenow') ?? null,
    meta: [...document.querySelectorAll('.upd-progress__meta span')].map((s) => s.textContent).join(' / ')
  })`);
  mark("downloading", progress);
  await shot("03-downloading");

  if (
    !(await waitFor(
      "!!document.querySelector('.upd-badge-ok') && (document.querySelector('.upd-lead')?.textContent ?? '').includes('签名校验')",
      40_000,
    ))
  ) {
    throw new Error("下载或签名校验未完成");
  }
  const ready = await evalJs(`({
    lead: document.querySelector('.upd-lead')?.textContent ?? '',
    hint: document.querySelector('.settings-card__hint')?.textContent ?? '',
    buttons: [...document.querySelectorAll('.upd-card .btn')].map((b) => b.textContent.trim())
  })`);
  mark("signature-verified", ready);
  await shot("04-ready");

  // 篡改安装包后重新下载：签名必须被拒绝。
  writeFileSync(BAD, "tampered");
  mark("bad-artifact-enabled", { marker: ".updater-fixture/tamper.flag" });
  await evalJs(
    `[...document.querySelectorAll('.upd-card .btn')].find((b) => b.textContent.includes('重新下载'))?.click()`,
  );
  if (!(await waitFor("!!document.querySelector('.upd-error')", 40_000))) {
    throw new Error("签名不匹配未被拒绝");
  }
  const rejected = await evalJs(`({
    code: document.querySelector('.upd-error__code')?.textContent ?? '',
    title: document.querySelector('.upd-error__title')?.textContent ?? '',
    message: document.querySelector('.upd-error__msg')?.textContent ?? ''
  })`);
  mark("signature-rejected", rejected);
  await shot("05-signature-error");

  // 重试入口：再次进入下载，仍被拒绝（验证可重试且错误码稳定）。
  await evalJs(
    `[...document.querySelectorAll('.upd-card .btn')].find((b) => b.textContent.includes('重试'))?.click()`,
  );
  const retriedDownload = await waitFor("!!document.querySelector('.upd-progress')", 5_000);
  const retriedError = await waitFor("!!document.querySelector('.upd-error')", 40_000);
  mark("retry", { retriedDownload, retriedError, code: await evalJs("document.querySelector('.upd-error__code')?.textContent ?? ''") });

  unlinkSync(BAD);
  const result = {
    generatedAt: new Date().toISOString(),
    screenshots: [
      "01-silent-badge",
      "02-available",
      "02b-available-dark",
      "03-downloading",
      "04-ready",
      "05-signature-error",
    ],
    silentBadge,
    available,
    progress,
    ready,
    rejected,
    retry: { retriedDownload, retriedError },
    timeline,
  };
  writeFileSync(join(OUT, "updater-probe-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  rpc.ws.close();
}

main().catch((err) => {
  console.error("updater probe failed:", err.message);
  process.exit(1);
});
