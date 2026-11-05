// M0 GUI 探针（第二轮修订）：通过 WebView2 远程调试（CDP）驱动自测页。
// 关键变化：
//  1) 时序全部由探针按真实时间驱动（window.__m0Api），页面不再依赖 setTimeout；
//  2) 采样期间记录 document.hidden / visibilityState，并把每次 rAF 间隔落盘；
//  3) 8 标签空闲 CPU 由 win-cpu.ps1 采样进程树（应用 + msedgewebview2）。
// 用法：node scripts/m0-gui-probe.mjs [port] [outDir] [appPid]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.argv[2] ?? 9223);
const OUT = process.argv[3] ?? "docs/qa";
const APP_PID = Number(process.argv[4] ?? 0);
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = Date.now() + 75_000;

async function pickTarget() {
  for (let i = 0; i < 24; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* WebView2 尚未就绪 */
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

function cpuSample(rootPid) {
  const script = join("scripts", "win-cpu.ps1");
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-RootPid", String(rootPid), "-Ms", "3000"],
    { encoding: "utf8", timeout: 20_000 },
  );
  const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(line);
}

async function main() {
  const target = await pickTarget();
  const rpc = createRpc(target.webSocketDebuggerUrl);
  await rpc.opened;
  await rpc.call("Page.enable");
  await rpc.call("Runtime.enable");
  await rpc.call("Page.bringToFront");

  const evalJs = async (expression) => {
    const res = await rpc.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(`JS 异常: ${res.exceptionDetails.text}`);
    return res.result?.value;
  };

  const waitFor = async (expr, timeoutMs, stepMs = 300, onPoll) => {
    const until = Math.min(Date.now() + timeoutMs, DEADLINE);
    while (Date.now() < until) {
      const value = await evalJs(expr);
      if (onPoll) await onPoll(value);
      if (value) return true;
      await sleep(stepMs);
    }
    return false;
  };

  // 标记注入 → 原位 reload（Tauri asset 协议可能忽略 query）
  await rpc.call("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__M0_SELFTEST__ = true;",
  });
  await rpc.call("Page.reload", { ignoreCache: true });
  await sleep(1200);

  if (!(await waitFor("!!document.querySelector('.selftest')", 15_000, 400))) {
    const diag = await evalJs(
      "({href: location.href, title: document.title, text: (document.body.innerText||'').slice(0,120)})",
    );
    throw new Error(`自测页面未挂载: ${JSON.stringify(diag)}`);
  }
  if (!(await waitFor("!!window.__m0Api && window.__m0Api.status().ready", 20_000))) {
    throw new Error("终端 20s 内未就绪");
  }

  const shot = async (name) => {
    const { data } = await rpc.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  };

  const visPolls = [];
  const recordVis = async () => {
    visPolls.push(await evalJs("window.__m0Api.status()"));
  };

  // 1) 8 标签空闲 CPU（先测，避免负载热缓存）
  const idle = await evalJs("window.__m0Api.openIdle(8)");
  await sleep(2500);
  const cpu = APP_PID ? cpuSample(APP_PID) : null;
  await evalJs("window.__m0Api.closeIdle()");
  await sleep(1500);
  await recordVis();

  // 2) 两档尺寸 + stty 回读
  await evalJs("window.__m0Api.resize(480, 320)");
  await sleep(700);
  const small = await evalJs("window.__m0Api.stty()");
  await sleep(500);
  await recordVis();
  await shot("m0-small");
  await evalJs("window.__m0Api.resize(900, 620)");
  await sleep(700);
  const large = await evalJs("window.__m0Api.stty()");
  await sleep(500);
  await recordVis();
  await shot("m0-back");

  // 3) 类 top 负载 12s（rAF/帧间隔/可见性）
  await evalJs("window.__m0Api.beginTop(12)");
  const topOk = await waitFor("window.__m0Api.status().topFinished", 20_000, 400, recordVis);
  if (!topOk) throw new Error("top 负载 20s 内未结束");

  // 4) 16MiB 冲量
  await evalJs("window.__m0Api.beginBurst(16)");
  const burstOk = await waitFor("window.__m0Api.status().burstFinished", 25_000, 400, recordVis);
  if (!burstOk) throw new Error("burst 25s 内未结束");

  const result = await evalJs("window.__m0Api.publish()");
  result.sizes = { small: small ? `${small.rows}行×${small.cols}列` : null, large: large ? `${large.rows}行×${large.cols}列` : null };
  result.idleTabs = idle;
  result.cpu = cpu;
  result.visibilityPolls = visPolls.map((p) => ({
    hidden: p.hidden,
    vis: p.vis,
    phase: p.phase,
  }));
  result.verdict = {
    throughput: { pass: result.burst.mbps >= 10 && result.seqGaps === 0, value: `${result.burst.mbps.toFixed(2)}MB/s`, line: ">=10MB/s 且 seqGaps=0" },
    frameLatency: { pass: result.frameP95Ms <= 12, value: `${result.frameP95Ms.toFixed(2)}ms`, line: "<=12ms" },
    idleCpu: { pass: !!cpu && cpu.pctSingle <= 3, value: cpu ? `${cpu.pctSingle}% (单核折算)` : "未测", line: "<=3%" },
  };

  writeFileSync(join(OUT, "m0-gui-results.json"), JSON.stringify(result, null, 2));

  // 每次 rAF 间隔单独落盘，便于核对是否进入遮挡节流。
  const rafLines = ["# index\tgapMs\tvis"];
  (result.rafGaps ?? []).forEach((gap, i) => {
    rafLines.push(`${i}\t${Number(gap).toFixed(3)}\t${result.visibility.state}`);
  });
  writeFileSync(join(OUT, "m0-raf.log"), rafLines.join("\n") + "\n");

  console.log(JSON.stringify({ ...result, rafGaps: `[${result.rafGaps.length} 项，见 m0-raf.log]` }, null, 2));
  rpc.ws.close();
}

main().catch((err) => {
  console.error("probe failed:", err.message);
  process.exit(1);
});
