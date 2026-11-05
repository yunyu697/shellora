// M0 性能自测页：仅在 URL 带 `?selftest=1`（或注入 __M0_SELFTEST__）时挂载。
// 时序由 CDP 探针驱动（window.__m0Api），不依赖页面 setTimeout：
//   resize/stty → 8 标签空闲 → top 负载 → burst 冲量 → publish。

import { useEffect, useRef, useState } from "react";
import type { ConnStateDto } from "../../lib/ipc/types";
import { closeTerminal, openDetached } from "../../lib/ipc/commands";
import { useTerminal } from "../terminal/useTerminal";

const LARGE = { w: 900, h: 620 };
const FRAME_BUDGET_MS = 1000 / 60;

interface Stats {
  total: number;
  frames: number;
  seqGaps: number;
  lastSeq: number;
  topStart: number;
  topEnd: number;
  topBytes: number;
  burstStart: number;
  burstEnd: number;
  burstBytes: number;
  heapStart: number;
  tail: string;
  sizes: Record<string, string>;
  frameGaps: number[];
  lastFrame: number;
  rafGaps: number[];
  rafLast: number;
  sampling: boolean;
  topFinished: boolean;
  burstFinished: boolean;
  idleTabs: string[];
}

function heapMB(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize / 1024 / 1024 : 0;
}

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function droppedFrames(gaps: number[]): number {
  let dropped = 0;
  for (const gap of gaps) {
    if (gap > FRAME_BUDGET_MS) dropped += Math.max(0, Math.round(gap / FRAME_BUDGET_MS) - 1);
  }
  return dropped;
}

export function SelfTest() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState("connecting");
  const [box, setBox] = useState(LARGE);
  const [summary, setSummary] = useState("");
  const readyRef = useRef(false);
  const apiRef = useRef<{
    send: (text: string) => void;
    size: () => { cols: number; rows: number } | null;
  } | null>(null);
  const stats = useRef<Stats>({
    total: 0,
    frames: 0,
    seqGaps: 0,
    lastSeq: 0,
    topStart: 0,
    topEnd: 0,
    topBytes: 0,
    burstStart: 0,
    burstEnd: 0,
    burstBytes: 0,
    heapStart: 0,
    tail: "",
    sizes: {},
    frameGaps: [],
    lastFrame: 0,
    rafGaps: [],
    rafLast: 0,
    sampling: false,
    topFinished: false,
    burstFinished: false,
    idleTabs: [],
  });

  const publish = () => {
    const s = stats.current;
    const topMs = s.topEnd - s.topStart;
    const burstMs = s.burstEnd - s.burstStart;
    const result = {
      sizes: s.sizes,
      visibility: { state: document.visibilityState, hidden: document.hidden },
      top: {
        seconds: topMs / 1000,
        bytes: s.topBytes,
        mbps: topMs > 0 ? s.topBytes / 1024 / 1024 / (topMs / 1000) : 0,
      },
      burst: {
        ms: burstMs,
        bytes: s.burstBytes,
        mbps: burstMs > 0 ? s.burstBytes / 1024 / 1024 / (burstMs / 1000) : 0,
      },
      frames: s.frames,
      seqGaps: s.seqGaps,
      frameSamples: s.frameGaps.length,
      frameP95Ms: p95(s.frameGaps),
      frameMaxMs: s.frameGaps.length ? Math.max(...s.frameGaps) : 0,
      rafSamples: s.rafGaps.length,
      rafP95Ms: p95(s.rafGaps),
      rafMaxMs: s.rafGaps.length ? Math.max(...s.rafGaps) : 0,
      droppedFrames: droppedFrames(s.rafGaps),
      heapStartMB: s.heapStart,
      heapEndMB: heapMB(),
      heapGrowthMB: heapMB() - s.heapStart,
      totalBytes: s.total,
      rafGaps: s.rafGaps,
      frameGaps: s.frameGaps,
    };
    (window as unknown as { __m0?: unknown }).__m0 = result;
    setSummary(JSON.stringify({ ...result, rafGaps: undefined, frameGaps: undefined }, null, 2));
    setPhase("done");
    return result;
  };

  const onBytes = (bytes: Uint8Array, seq: number) => {
    const s = stats.current;
    const now = performance.now();
    s.total += bytes.byteLength;
    s.frames += 1;
    if (s.lastSeq && seq !== s.lastSeq + 1) s.seqGaps += 1;
    s.lastSeq = seq;

    if (s.sampling) {
      if (s.lastFrame) s.frameGaps.push(now - s.lastFrame);
      s.lastFrame = now;
    }
    if (s.topStart && !s.topEnd) s.topBytes += bytes.byteLength;
    if (s.burstStart && !s.burstEnd) s.burstBytes += bytes.byteLength;

    // 标记可能跨帧，保留 4KB 尾巴再匹配。
    s.tail = (s.tail + new TextDecoder().decode(bytes)).slice(-4096);
    if (s.tail.includes("@@BENCH_TOP_START@@")) {
      s.topStart = now;
      s.topEnd = 0;
      s.topBytes = 0;
      s.frameGaps = [];
      s.lastFrame = 0;
      s.rafGaps = [];
      s.sampling = true;
      s.tail = "";
    } else if (s.tail.includes("@@BENCH_TOP_END@@")) {
      s.topEnd = now;
      s.sampling = false;
      s.topFinished = true;
      s.tail = "";
      setPhase("top-end");
    } else if (s.tail.includes("@@BENCH_BURST_START@@")) {
      s.burstStart = now;
      s.burstEnd = 0;
      s.burstBytes = 0;
      s.frameGaps = [];
      s.lastFrame = 0;
      s.rafGaps = [];
      s.sampling = true;
      s.tail = "";
    } else if (s.tail.includes("@@BENCH_BURST_END@@")) {
      s.burstEnd = now;
      s.sampling = false;
      s.burstFinished = true;
      s.tail = "";
      setPhase("burst-end");
    }
  };

  const api = useTerminal(
    hostRef,
    { host: "127.0.0.1", port: 2222, username: "alice", password: "secret", cols: 80, rows: 24 },
    {
      onState: (state: ConnStateDto) => {
        if (state.state === "ready") readyRef.current = true;
        if (state.state === "failed") setPhase("failed");
      },
      onTitle: () => undefined,
      onTabId: () => undefined,
      onBytes,
    },
  );
  apiRef.current = api;

  useEffect(() => {
    (window as unknown as { __m0Phase?: string }).__m0Phase = phase;
  }, [phase]);

  // rAF 采样：只在 top/burst 的测量窗口内记录，避免空闲期噪音。
  useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      const s = stats.current;
      if (s.sampling) {
        if (s.rafLast) s.rafGaps.push(t - s.rafLast);
        s.rafLast = t;
      } else {
        s.rafLast = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 暴露给 CDP 探针：所有时序由外部按真实时间驱动。
  useEffect(() => {
    const apiObj = {
      status: () => {
        const s = stats.current;
        return {
          phase: (window as unknown as { __m0Phase?: string }).__m0Phase ?? "",
          ready: readyRef.current,
          frames: s.frames,
          seqGaps: s.seqGaps,
          topFinished: s.topFinished,
          burstFinished: s.burstFinished,
          hidden: document.hidden,
          vis: document.visibilityState,
          idle: s.idleTabs.length,
        };
      },
      ready: () => readyRef.current,
      resize: (w: number, h: number) => {
        setBox({ w, h });
      },
      stty: () => {
        apiRef.current?.send("stty size\r");
        const size = apiRef.current?.size();
        return size ? { cols: size.cols, rows: size.rows } : null;
      },
      beginTop: (seconds: number) => {
        const s = stats.current;
        s.topFinished = false;
        s.burstFinished = false;
        s.heapStart = heapMB();
        s.sizes = { ...s.sizes };
        setPhase("top");
        apiRef.current?.send(`bench top ${seconds}\r`);
      },
      beginBurst: (mb: number) => {
        const s = stats.current;
        s.burstFinished = false;
        setPhase("burst");
        apiRef.current?.send(`bench burst ${mb}\r`);
      },
      publish: () => publish(),
      openIdle: async (count: number) => {
        const s = stats.current;
        for (let i = 0; i < count; i++) {
          const { tabId } = await openDetached({
            host: "127.0.0.1",
            port: 2222,
            username: "alice",
            password: "secret",
            cols: 80,
            rows: 24,
          });
          s.idleTabs.push(tabId);
        }
        return s.idleTabs.length;
      },
      closeIdle: async () => {
        const s = stats.current;
        const ids = s.idleTabs.splice(0);
        for (const id of ids) await closeTerminal(id).catch(() => undefined);
        return ids.length;
      },
    };
    (window as unknown as { __m0Api?: unknown }).__m0Api = apiObj;
  }, []);

  const s = stats.current;

  return (
    <div className="selftest">
      <div className="selftest__bar">
        <strong>M0 自测</strong>
        <span>phase={phase}</span>
        <span>frames={s.frames}</span>
        <span>seqGaps={s.seqGaps}</span>
        <span>vis={document.visibilityState}</span>
      </div>
      <div ref={hostRef} className="selftest__term" style={{ width: box.w, height: box.h }} />
      {summary ? <pre className="selftest__out">{summary}</pre> : null}
    </div>
  );
}
