// M0 IPC 基准：测量 Channel<StreamMsg> 的收齐吞吐与帧间隔。
// 只在 WebView 的 DevTools 控制台运行（依赖 Tauri IPC 上下文），用法见 docs/bench/ipc-m0.md。
// 注意：默认命令 dd 需要真实 OpenSSH；仓库内 fixture_sshd 不支持 dd。

import { Channel, invoke } from "@tauri-apps/api/core";

interface StreamMsg {
  k: "data" | "bell" | "title" | "eof";
  seq?: number;
  b?: number[];
}

export interface BenchOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  /** 产生大量输出的远端命令 */
  command?: string;
  /** 期望收齐的字节数 */
  bytes?: number;
  /** 收齐后自动关闭标签 */
  keepOpen?: boolean;
}

export interface BenchResult {
  bytes: number;
  frames: number;
  elapsedMs: number;
  throughputMBps: number;
  seqGaps: number;
  frameGapP95Ms: number;
}

export async function runIpcBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const bytesTarget = opts.bytes ?? 200 * 1024 * 1024;
  const command =
    opts.command ?? `dd if=/dev/urandom bs=1M count=${Math.ceil(bytesTarget / 1024 / 1024)} status=none`;
  const input = {
    host: opts.host ?? "127.0.0.1",
    port: opts.port ?? 22,
    username: opts.username ?? "",
    password: opts.password ?? "",
    cols: 100,
    rows: 30,
  };

  const connector = new Channel<StreamMsg>();
  let received = 0;
  let frames = 0;
  let lastSeq = 0;
  let seqGaps = 0;
  const gaps: number[] = [];
  let lastAt = 0;
  let tabId: string | null = null;
  let startedAt = 0;
  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  connector.onmessage = (msg) => {
    if (msg.k !== "data") return;
    const at = performance.now();
    if (lastAt > 0) gaps.push(at - lastAt);
    lastAt = at;

    const size = msg.b?.length ?? 0;
    received += size;
    frames += 1;
    if (msg.seq !== undefined) {
      if (lastSeq !== 0 && msg.seq !== lastSeq + 1) seqGaps += 1;
      lastSeq = msg.seq;
    }
    if (tabId) void invoke("terminal_ack", { tabId, bytes: size });
    if (received >= bytesTarget) done();
  };

  const { tabId: id } = await invoke<{ tabId: string }>("terminal_open", { input, channel: connector });
  tabId = id;

  // 等首个提示符，再开始计时。
  await new Promise((r) => setTimeout(r, 600));
  startedAt = performance.now();
  await invoke("terminal_input", { tabId: id, data: `${command}\n` });

  const timeout = setTimeout(() => done(), 120_000);
  await finished;
  clearTimeout(timeout);

  const elapsedMs = performance.now() - startedAt;
  gaps.sort((a, b) => a - b);
  const frameGapP95Ms = gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0;
  const result: BenchResult = {
    bytes: received,
    frames,
    elapsedMs,
    throughputMBps: received / 1024 / 1024 / (elapsedMs / 1000),
    seqGaps,
    frameGapP95Ms,
  };

  if (!opts.keepOpen) await invoke("terminal_close", { tabId: id });
  console.table(result);
  return result;
}
