import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  connTest,
  dbCreateSession,
  dbDeleteConnection,
  dbInsertConnection,
  dbListConnections,
  dbListSessions,
  knownHostDelete,
  knownHostList,
  probeSecret,
  setCaptionRegions,
  traySync,
} from "./lib/ipc/commands";
import type {
  ConnStateDto,
  ConnectionInput,
  ConnectionRow,
  ErrorDto,
  HostKeyDetails,
  JumpInput,
  ProxyInput,
  SecretProbeDto,
  SessionRow,
} from "./lib/ipc/types";
import { Icon } from "./components/Icons";
import { TerminalPane } from "./features/terminal/TerminalPane";
import { SftpManager, type SftpSummary } from "./features/sftp/SftpManager";
import { UpdateButton } from "./features/updater/UpdateButton";
import { DataResetButton } from "./features/settings/DataResetButton";
import { TraySettings } from "./features/settings/TraySettings";
import { applyUiTheme, loadUiTheme, storeUiTheme, type UiTheme } from "./theme";
import brandDark from "./assets/brand/shellora-dark.svg";
import brandLight from "./assets/brand/shellora-light.svg";

const MAX_TABS = 30;
const RAIL_KEY = "shellora.railCollapsed";
const PANEL_WIDTH_KEY = "shellora.panelWidth";

/** 会话栏折叠状态：默认展开，仅本地偏好，不影响任何业务数据。 */
function loadRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

type AuthMode = "password" | "key" | "agent";
type ProxyKind = "none" | "socks5" | "httpConnect";
type View = "files" | "connect";
type RailTab = "all" | "saved" | "recent";

const DEFAULT_FORM = {
  name: "本地夹具",
  host: "127.0.0.1",
  port: "2222",
  username: "alice",
  authMode: "password" as AuthMode,
  password: "secret",
  keyPath: "",
  keyPassphrase: "",
  agentSocket: "",
  agentKey: "",
  proxyKind: "none" as ProxyKind,
  proxyHost: "127.0.0.1",
  proxyPort: "1080",
  proxyUser: "",
  proxyPass: "",
};

type FormState = typeof DEFAULT_FORM;

interface JumpForm {
  host: string;
  port: string;
  username: string;
  password: string;
}

interface TabState {
  key: string;
  input: ConnectionInput;
  label: string;
  state: ConnStateDto;
  tabId: string | null;
}

interface Message {
  tone: "hint" | "warn";
  text: string;
}

/** host key 拦截弹窗：未知主机确认 / 指纹变更风险提示。 */
interface HostKeyPrompt {
  kind: "unknown" | "changed";
  input: ConnectionInput;
  connectionId: string | null;
  details: HostKeyDetails;
}

const STATE_TEXT: Record<string, string> = {
  connecting: "连接中",
  ready: "已连接",
  suspended: "已挂起",
  closed: "已断开",
  failed: "连接失败",
};

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  const dto = err as { message?: string; code?: string } | null | undefined;
  return dto?.message ?? dto?.code ?? String(err);
}

function authLabel(input: ConnectionInput): string {
  if (input.privateKey) return "私钥";
  if (input.agent) return "agent";
  return "密码";
}

applyUiTheme(loadUiTheme(window.localStorage));

/** 仅 `?preview=1` 视觉回归时由夹具注入；正常运行下为空。 */
const previewTab = (window as unknown as { __SHELLORA_PREVIEW_TAB__?: TabState })
  .__SHELLORA_PREVIEW_TAB__;
const previewView = (window as unknown as { __SHELLORA_PREVIEW_VIEW__?: View })
  .__SHELLORA_PREVIEW_VIEW__;
const previewCwd = (window as unknown as { __SHELLORA_PREVIEW_CWD__?: string })
  .__SHELLORA_PREVIEW_CWD__;

const IS_MAC = typeof navigator !== "undefined" && /Mac OS X/i.test(navigator.userAgent);
/** 浏览器预览（vite dev server）没有 Tauri 注入，窗口 API 一律跳过 */
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/** macOS 走原生红绿灯 + Overlay 标题栏，其余平台自绘窗口控制 */
function useWindowMaximized(): [boolean, () => void] {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!IS_TAURI) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      win
        .isMaximized()
        .then((v) => {
          if (alive) setMaximized(v);
        })
        .catch(() => {});
    };
    sync();
    const un = win.onResized(sync);
    return () => {
      alive = false;
      void un.then((off) => off()).catch(() => {});
    };
  }, []);
  return [maximized, () => {
    if (IS_TAURI) void getCurrentWindow().toggleMaximize();
  }];
}

function WindowControls({
  maximized,
  onToggle,
  hover,
}: {
  maximized: boolean;
  onToggle: () => void;
  hover: boolean;
}) {
  if (IS_MAC) return null;
  return (
    <div className="wincontrols">
      <button
        type="button"
        className="wc"
        aria-label="最小化"
        title="最小化"
        onClick={() => {
          if (IS_TAURI) void getCurrentWindow().minimize();
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M2 6h8" />
        </svg>
      </button>
      <button
        type="button"
        className={hover ? "wc wc--hover" : "wc"}
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        onClick={onToggle}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3.5 4.5v-2h6v6h-2" />
            <path d="M2.5 4.5h5v5h-5z" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 2.5h7v7h-7z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="wc wc--close"
        aria-label="关闭"
        title="关闭"
        onClick={() => {
          if (IS_TAURI) void getCurrentWindow().close();
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  );
}

/** 无边框窗口的八向缩放热区（最大化时关闭） */
function ResizeHandles({ enabled }: { enabled: boolean }) {
  if (IS_MAC || !enabled || !IS_TAURI) return null;
  const zones: Array<[ResizeDirection, string]> = [
    ["North", "n"],
    ["South", "s"],
    ["West", "w"],
    ["East", "e"],
    ["NorthWest", "nw"],
    ["NorthEast", "ne"],
    ["SouthWest", "sw"],
    ["SouthEast", "se"],
  ];
  return (
    <div className="rzones" aria-hidden>
      {zones.map(([dir, cls]) => (
        <div
          key={dir}
          className={`rz rz--${cls}`}
          onMouseDown={(ev: ReactMouseEvent) => {
            ev.preventDefault();
            void getCurrentWindow().startResizeDragging(dir);
          }}
        />
      ))}
    </div>
  );
}

type CaptionRect = [number, number, number, number];

/**
 * 自绘标题栏的原生命中区：量出顶栏空白段与最大化按钮后下发，
 * Windows 的 WndProc 据此返回 HTCAPTION / HTMAXBUTTON，
 * 于是系统拖动、双击最大化、Win11 贴靠布局都走原生路径。
 */
function useCaptionHitTest(signature: string) {
  useEffect(() => {
    if (!IS_TAURI || IS_MAC) return;
    let raf = 0;
    let timer = 0;
    let last = "";
    const measure = () => {
      const bar = document.querySelector<HTMLElement>(".topbar");
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      if (rect.height <= 0) return;
      const scale = window.devicePixelRatio || 1;
      const mid = Math.round(rect.top + rect.height / 2);
      const from = Math.round(rect.left + 4);
      const to = Math.round(rect.right - 4);
      const top = Math.round(rect.top + 4);
      const height = Math.round(rect.height - 8);
      // 顶栏是单行布局：按 4px 步长采样中线，连续落在顶栏空白处的一段就是可拖动区。
      const blocked = (el: Element | null): boolean =>
        !el ||
        !bar.contains(el) ||
        !!el.closest("button,input,select,textarea,a,[role='button'],.searchbox");
      const spans: CaptionRect[] = [];
      let start = -1;
      for (let x = from; x < to; x += 4) {
        const free = !blocked(document.elementFromPoint(x, mid));
        if (free && start < 0) start = x;
        if (!free && start >= 0) {
          spans.push([start, top, x - start, height]);
          start = -1;
        }
      }
      if (start >= 0) spans.push([start, top, to - start, height]);
      const maxBtn = document.querySelector<HTMLElement>(".wincontrols .wc:nth-child(2)");
      const box = maxBtn?.getBoundingClientRect();
      const maxRect: CaptionRect | null =
        box && box.width > 0
          ? [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]
          : null;
      const key = JSON.stringify([spans, maxRect, scale]);
      if (key === last) return;
      last = key;
      void setCaptionRegions(spans, maxRect, scale).catch(() => {});
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const delayed = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(schedule, 160);
    };
    schedule();
    // 字体/图标加载会移动横向位置，稍后再量一次
    const settle = window.setTimeout(schedule, 500);
    const un = getCurrentWindow().onResized(delayed);
    window.addEventListener("resize", delayed);
    const observer = new ResizeObserver(delayed);
    const bar = document.querySelector(".topbar");
    if (bar) observer.observe(bar);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.clearTimeout(settle);
      window.removeEventListener("resize", delayed);
      observer.disconnect();
      void un.then((off) => off()).catch(() => {});
    };
  }, [signature]);
}

/** 最大化按钮落在 HTMAXBUTTON 区时 DOM 收不到鼠标事件，用 Rust 转发的事件补悬停态。 */
function useCaptionHover(): boolean {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!IS_TAURI || IS_MAC) return;
    const un = listen<{ hover: boolean }>("shellora://caption", (ev) => setHover(!!ev.payload?.hover));
    return () => {
      void un.then((off) => off()).catch(() => {});
    };
  }, []);
  return hover;
}

export default function App() {
  const [maximized, toggleMaximize] = useWindowMaximized();
  const maxHover = useCaptionHover();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [jumps, setJumps] = useState<JumpForm[]>([]);
  const [probe, setProbe] = useState<SecretProbeDto | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [trayToast, setTrayToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tabs, setTabs] = useState<TabState[]>(() => (previewTab ? [previewTab] : []));
  const [activeKey, setActiveKey] = useState(previewTab?.key ?? "");
  /** OSC 7：每个标签最近一次上报的远端 cwd */
  const [tabCwd, setTabCwd] = useState<Record<string, string>>(() =>
    previewTab && previewCwd ? { [previewTab.key]: previewCwd } : {},
  );
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(null);
  const [theme, setTheme] = useState<UiTheme>(() => loadUiTheme(window.localStorage));
  const [appVersion, setAppVersion] = useState("");
  const [view, setView] = useState<View>(previewView === "connect" ? "connect" : "files");
  const [railTab, setRailTab] = useState<RailTab>("all");
  const [railQuery, setRailQuery] = useState("");
  const [railCollapsed, setRailCollapsed] = useState<boolean>(loadRailCollapsed);
  const [railPulse, setRailPulse] = useState(false);
  const [sftpSummary, setSftpSummary] = useState<SftpSummary | null>(null);
  const seqRef = useRef(0);
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const activeRailRowRef = useRef<HTMLDivElement | null>(null);

  // ---- 文件抽屉：终端始终是全宽主视区，文件按需呼出 ----
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelLayout, setPanelLayout] = useState<"push" | "overlay">("push");
  const [panelWidth, setPanelWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  /** 记录「刚读回的宽度」，避免把上一个会话的宽度写进新会话的键里 */
  const loadedWidthRef = useRef<{ key: string; w: number } | null>(null);
  /** 读回的值还没落到 state 上时置 true，期间的宽度变化一律不写回 */
  const awaitingWidthRef = useRef(false);

  /** 最小 340（五个操作按钮不被裁切），最大 720 / 窗口 56%，挤压态终端至少留 560 */
  const clampPanelWidth = useCallback((w: number) => {
    const vw = window.innerWidth || 1440;
    const min = Math.min(340, Math.max(280, Math.round(vw * 0.42)));
    const max = Math.max(min, Math.min(720, Math.round(vw * 0.56), vw - 560));
    const n = Number.isFinite(w) && w > 0 ? Math.round(w) : 420;
    return Math.min(Math.max(n, min), max);
  }, []);

  const defaultPanelWidth = useCallback(() => {
    const vw = window.innerWidth || 1440;
    return vw >= 1700 ? 460 : vw < 1360 ? 380 : 420;
  }, []);

  // 启动 / 切换会话时读回该会话记住的宽度；窗口缩放时重新夹住（不覆盖已记住的值）
  useEffect(() => {
    let stored = 0;
    try {
      // 有会话时用该会话的宽度；无会话（刚启动）时用最后一次使用的宽度
      const key = activeKey ? `${PANEL_WIDTH_KEY}:${activeKey}` : PANEL_WIDTH_KEY;
      stored = Number(window.localStorage.getItem(key)) || 0;
    } catch {
      stored = 0;
    }
    const next = clampPanelWidth(stored || defaultPanelWidth());
    loadedWidthRef.current = { key: activeKey || "default", w: next };
    awaitingWidthRef.current = true;
    setPanelWidth(next);
  }, [activeKey, clampPanelWidth, defaultPanelWidth]);

  useEffect(() => {
    const onResize = () => setPanelWidth((w) => clampPanelWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPanelWidth]);

  // 写入 CSS 变量，宽度变化不影响 DOM 结构
  useEffect(() => {
    document.documentElement.style.setProperty("--panel-w", `${Math.round(panelWidth)}px`);
  }, [panelWidth]);

  // 宽度按会话分别记忆，切换会话互不干扰
  useEffect(() => {
    if (!panelWidth) return;
    const loaded = loadedWidthRef.current;
    if (awaitingWidthRef.current) {
      // 读回的值还没生效：这一帧（含切会话过渡帧）不写回
      if (loaded && panelWidth === loaded.w) awaitingWidthRef.current = false;
      return;
    }
    try {
      const w = String(Math.round(panelWidth));
      window.localStorage.setItem(`${PANEL_WIDTH_KEY}:${activeKey || "default"}`, w);
      // 同时留一份全局值：重启后没有活动会话时用它恢复上次宽度
      window.localStorage.setItem(PANEL_WIDTH_KEY, w);
    } catch {
      /* 隐私模式忽略 */
    }
  }, [panelWidth, activeKey]);

  const nudgePanelWidth = useCallback(
    (dir: number, step = 40) => setPanelWidth((w) => clampPanelWidth(w + dir * step)),
    [clampPanelWidth],
  );

  // Alt+P 切换挤压/覆盖；Alt+[ ] 调宽；Ctrl+Shift+E 呼出/收起面板
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "e") {
        ev.preventDefault();
        setPanelOpen((prev) => !prev);
        return;
      }
      if (ev.altKey && !typing && ev.key.toLowerCase() === "p" && panelOpen) {
        ev.preventDefault();
        setPanelLayout((prev) => (prev === "push" ? "overlay" : "push"));
        return;
      }
      if (ev.altKey && !typing && panelOpen && (ev.key === "[" || ev.key === "]")) {
        ev.preventDefault();
        nudgePanelWidth(ev.key === "[" ? 1 : -1, ev.shiftKey ? 120 : 40);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, nudgePanelWidth]);

  const startResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      /* 合成指针（测试/部分触控）没有可捕获的 pointerId，退回普通事件流 */
    }
    dragRef.current = { x: ev.clientX, w: panelWidth };
    setResizing(true);
  };
  const moveResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPanelWidth(clampPanelWidth(d.w + d.x - ev.clientX));
  };
  const endResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* 指针已释放 */
    }
  };

  // 文件面板 → 终端：拖入路径写入命令行，Shift 拖入变成 cd
  const [dropOver, setDropOver] = useState(false);
  const onTermDragOver = (ev: ReactDragEvent<HTMLElement>) => {
    if (!ev.dataTransfer.types.includes("text/plain")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    if (!dropOver) setDropOver(true);
  };
  const onTermDrop = (ev: ReactDragEvent<HTMLElement>) => {
    const raw = ev.dataTransfer.getData("text/plain");
    setDropOver(false);
    if (!raw) return;
    ev.preventDefault();
    const paths = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => (/[\s"'$]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p));
    if (!paths.length) return;
    const text =
      ev.shiftKey && paths.length === 1
        ? `cd ${paths[0]} `
        : paths.map((p) => `${p} `).join("");
    window.dispatchEvent(new CustomEvent("shellora:insert-path", { detail: { text } }));
  };

  useEffect(() => {
    applyUiTheme(theme, document.documentElement);
    storeUiTheme(theme, window.localStorage);
  }, [theme]);

  // 托盘菜单与 tooltip：标签 / 活动标签变化时同步给 Rust。
  useEffect(() => {
    if (!IS_TAURI) return;
    const list = tabs.map((t) => ({
      key: t.key,
      label: t.label,
      state: t.state.state,
      active: t.key === activeKey,
    }));
    const active = tabs.find((t) => t.key === activeKey);
    const connected =
      active && active.state.state === "ready"
        ? `${active.input.username}@${active.input.host}`
        : null;
    void traySync(list, connected).catch(() => {});
  }, [tabs, activeKey]);

  // 托盘菜单动作；首次驻留时在应用内提示“仍在后台运行”。
  useEffect(() => {
    if (!IS_TAURI) return;
    const unlisteners: Array<() => void> = [];
    let alive = true;
    void (async () => {
      try {
        const offNew = await listen("tray://new-connection", () => setView("connect"));
        const offActivate = await listen<string>("tray://activate-session", (ev) => {
          setActiveKey(ev.payload);
          setView("files");
        });
        const offHidden = await listen<{ first: boolean }>("tray://hidden", (ev) => {
          if (ev.payload?.first) setTrayToast("Shellora 仍在后台运行，可从托盘图标恢复");
        });
        if (!alive) {
          offNew();
          offActivate();
          offHidden();
          return;
        }
        unlisteners.push(offNew, offActivate, offHidden);
      } catch {
        /* 浏览器预览环境没有 Tauri 事件系统：忽略 */
      }
    })();
    return () => {
      alive = false;
      unlisteners.forEach((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!trayToast) return;
    const timer = window.setTimeout(() => setTrayToast(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [trayToast]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_KEY, railCollapsed ? "1" : "0");
    } catch {
      /* 隐私模式忽略 */
    }
  }, [railCollapsed]);

  // v2：会话库默认收起（终端独占主视区），Ctrl+B 或左上按钮按需呼出；
  // 窄窗口下文件面板默认覆盖，避免把终端压得过窄。
  useEffect(() => {
    setRailCollapsed(true);
    if (window.innerWidth < 1360) setPanelLayout("overlay");
  }, []);

  // 展开后定位当前会话：等列宽过渡（200ms）结束再滚动，避免被过渡打断。
  useEffect(() => {
    if (railCollapsed) {
      setRailPulse(false);
      return;
    }
    let raf = 0;
    let locateTimer = 0;
    let pulseTimer = 0;
    const locate = () => {
      const scroller = railScrollRef.current;
      const row = activeRailRowRef.current;
      if (!scroller || !row) return;
      const s = scroller.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      // 靠近顶部留 12px 呼吸位；短列表时自然不产生滚动。
      scroller.scrollTop = Math.max(0, scroller.scrollTop + (r.top - s.top) - 12);
      setRailPulse(true);
      pulseTimer = window.setTimeout(() => setRailPulse(false), 700);
    };
    raf = window.requestAnimationFrame(() => {
      locateTimer = window.setTimeout(locate, 220);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(locateTimer);
      window.clearTimeout(pulseTimer);
    };
  }, [railCollapsed]);

  // Ctrl/Cmd+B 折叠会话栏；输入框内保留浏览器默认行为。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "b") return;
      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      ev.preventDefault();
      setRailCollapsed((prev) => !prev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    void probeSecret()
      .then(setProbe)
      .catch(() => setProbe(null));
  }, []);

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  const refreshSessions = useCallback(async () => {
    setSessions(await dbListSessions());
  }, []);

  const refreshLibrary = useCallback(async () => {
    const [rows, list] = await Promise.all([dbListConnections(), dbListSessions()]);
    setConnections(rows);
    setSessions(list);
  }, []);

  useEffect(() => {
    void refreshLibrary().catch((err) =>
      setMessage({ tone: "warn", text: `会话库不可用：${errorText(err)}` }),
    );
  }, [refreshLibrary]);

  // Tauri 原生窗口级文件拖入：转发为自定义事件让 SftpManager 监听。
  // 浏览器预览环境里会抛错，忽略即可。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const wv = getCurrentWebview();
        unlisten = await wv.onDragDropEvent((ev) => {
          // 只关心 drop 事件（文件真正落进窗口时）
          if (ev.payload.type !== "drop") return;
          const paths: string[] = (ev.payload.paths ?? []).filter(
            (p: unknown) => typeof p === "string" && p.length > 0,
          );
          if (!paths.length) return;
          window.dispatchEvent(
            new CustomEvent("shellora:external-drop", { detail: { paths } }),
          );
        });
      } catch {
        // 浏览器预览环境下 `getCurrentWebview` 不可用：忽略
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const patch = (key: keyof FormState) => (ev: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: ev.target.value }));

  /** 认证段：按认证方式构造，缺必填项时提示并返回 null。 */
  const buildAuth = (): Pick<ConnectionInput, "password" | "privateKey" | "agent"> | null => {
    if (form.authMode === "key") {
      const path = form.keyPath.trim();
      if (!path) {
        setMessage({ tone: "warn", text: "私钥路径不能为空" });
        return null;
      }
      return {
        password: "",
        privateKey: { path, passphrase: form.keyPassphrase || null },
      };
    }
    if (form.authMode === "agent") {
      return {
        password: "",
        agent: {
          socket: form.agentSocket.trim() || null,
          key: form.agentKey.trim() || null,
        },
      };
    }
    if (!form.password) {
      setMessage({ tone: "warn", text: "密码为空：按 D1 密码不入库，请本次输入" });
      return null;
    }
    return { password: form.password };
  };

  /** 代理段：返回 undefined 表示不使用代理，null 表示填写有误。 */
  const buildProxy = (): ProxyInput | undefined | null => {
    if (form.proxyKind === "none") return undefined;
    const host = form.proxyHost.trim();
    if (!host) {
      setMessage({ tone: "warn", text: "代理主机不能为空" });
      return null;
    }
    const port = Number.parseInt(form.proxyPort, 10);
    return {
      kind: form.proxyKind,
      host,
      port: Number.isFinite(port) ? port : 1080,
      username: form.proxyUser.trim() || null,
      password: form.proxyPass || null,
    };
  };

  /** 跳板链：按表单顺序生成，任一跳信息不全则中止。 */
  const buildJumps = (): JumpInput[] | null => {
    const out: JumpInput[] = [];
    for (const j of jumps) {
      const host = j.host.trim();
      const username = j.username.trim();
      if (!host || !username) {
        setMessage({ tone: "warn", text: "跳板的主机与用户名不能为空" });
        return null;
      }
      const port = Number.parseInt(j.port, 10);
      out.push({
        host,
        port: Number.isFinite(port) ? port : 22,
        username,
        password: j.password,
      });
    }
    return out;
  };

  /** 组装 ConnectionInput；任一段校验失败返回 null。 */
  const makeInput = (
    host: string,
    port: number,
    username: string,
  ): ConnectionInput | null => {
    if (!host || !username) {
      setMessage({ tone: "warn", text: "主机与用户名不能为空" });
      return null;
    }
    const auth = buildAuth();
    if (!auth) return null;
    const proxy = buildProxy();
    if (proxy === null) return null;
    const jumpList = buildJumps();
    if (!jumpList) return null;
    return {
      host,
      port,
      username,
      cols: 80,
      rows: 24,
      ...auth,
      ...(proxy ? { proxy } : {}),
      jumps: jumpList,
    };
  };

  const buildInput = (): ConnectionInput | null => {
    const port = Number.parseInt(form.port, 10);
    return makeInput(form.host.trim(), Number.isFinite(port) ? port : 22, form.username.trim());
  };

  const openTab = (input: ConnectionInput, connectionId: string | null) => {
    if (tabs.length >= MAX_TABS) {
      setMessage({ tone: "warn", text: `已达上限 ${MAX_TABS}，请先关闭标签` });
      return;
    }
    const key = `tab-${++seqRef.current}`;
    const label = `${input.username}@${input.host}`;
    setTabs((prev) => [
      ...prev,
      { key, input, label, state: { state: "connecting", reason: null }, tabId: null },
    ]);
    setActiveKey(key);
    setView("files");
    setMessage(null);

    if (!connectionId) return;
    void (async () => {
      try {
        const exists = sessions.some(
          (s) => s.connectionId === connectionId && s.name === label,
        );
        if (!exists) {
          await dbCreateSession(connectionId, label);
          await refreshSessions();
        }
      } catch (err) {
        setMessage({ tone: "warn", text: errorText(err) });
      }
    })();
  };

  /**
   * 建立标签前先 `conn_test`：host key 未知/变更时阻断，弹窗确认后才真正开会话。
   */
  const startTab = async (input: ConnectionInput, connectionId: string | null) => {
    setBusy(true);
    try {
      await connTest(input);
      openTab(input, connectionId);
    } catch (err) {
      const dto = err as ErrorDto | null;
      if (
        dto &&
        (dto.code === "HOSTKEY_UNKNOWN" || dto.code === "HOSTKEY_CHANGED") &&
        dto.details
      ) {
        setHostKeyPrompt({ kind: dto.details.kind, input, connectionId, details: dto.details });
        setMessage(null);
      } else {
        setMessage({ tone: "warn", text: `连接失败：${errorText(err)}` });
      }
    } finally {
      setBusy(false);
    }
  };

  /** 用户确认首次连接后，带 `trustNewHostKeys` 重试；指纹变更绝不会走到这里。 */
  const trustNewHost = () => {
    if (!hostKeyPrompt) return;
    const next = { ...hostKeyPrompt.input, trustNewHostKeys: true };
    const connectionId = hostKeyPrompt.connectionId;
    setHostKeyPrompt(null);
    void startTab(next, connectionId);
  };

  /** 指纹变更的唯一恢复路径：手动删除旧记录，由用户重新点击连接。 */
  const deleteBlockedHost = async () => {
    if (!hostKeyPrompt) return;
    const { details } = hostKeyPrompt;
    setBusy(true);
    try {
      const rows = await knownHostList();
      const stale = rows.filter((r) => r.host === details.host && r.port === details.port);
      for (const row of stale) await knownHostDelete(row.id);
      setHostKeyPrompt(null);
      setMessage({
        tone: "hint",
        text: `已删除 ${details.host}:${details.port} 的信任记录（${stale.length} 条），请重新点击连接。`,
      });
    } catch (err) {
      setMessage({ tone: "warn", text: `删除失败：${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const input = buildInput();
    if (input) void startTab(input, null);
  };

  const testConnection = async () => {
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    setMessage({ tone: "hint", text: "测试连接中（仅连接 + 认证，15s 超时）…" });
    try {
      await connTest(input);
      setMessage({ tone: "hint", text: "测试通过：连接与认证成功" });
    } catch (err) {
      setMessage({ tone: "warn", text: `测试失败：${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const saveConnection = async () => {
    const host = form.host.trim();
    const username = form.username.trim();
    if (!host || !username) {
      setMessage({ tone: "warn", text: "主机与用户名不能为空" });
      return;
    }
    const port = Number.parseInt(form.port, 10);
    const name = form.name.trim() || `${username}@${host}`;
    setBusy(true);
    try {
      await dbInsertConnection({
        name,
        host,
        port: Number.isFinite(port) ? port : 22,
        username,
        authKind: "password",
        credentialRefId: null,
      });
      await refreshLibrary();
      setMessage({ tone: "hint", text: `已保存连接「${name}」（密码不入库，下次连接时输入）` });
    } catch (err) {
      setMessage({ tone: "warn", text: `保存失败：${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = async (row: ConnectionRow) => {
    try {
      const removed = await dbDeleteConnection(row.id);
      await refreshLibrary();
      setMessage({
        tone: "hint",
        text: removed > 0 ? `已删除连接「${row.name}」，其会话一并删除` : "连接不存在",
      });
    } catch (err) {
      setMessage({ tone: "warn", text: `删除失败：${errorText(err)}` });
    }
  };

  const selectConnection = (row: ConnectionRow) => {
    setForm((prev) => ({
      ...prev,
      name: row.name,
      host: row.host,
      port: String(row.port),
      username: row.username,
    }));
    setView("connect");
    setMessage({ tone: "hint", text: "已载入连接信息，请确认密码后连接" });
  };

  const openConnection = (row: ConnectionRow) => {
    const input = makeInput(row.host, row.port, row.username);
    if (input) void startTab(input, row.id);
  };

  const openSession = (row: SessionRow) => {
    const connection = connections.find((c) => c.id === row.connectionId);
    if (!connection) {
      setMessage({ tone: "warn", text: "会话所属连接已不存在" });
      return;
    }
    const input = makeInput(connection.host, connection.port, connection.username);
    if (input) void startTab(input, connection.id);
  };

  const closeTab = (key: string) => {
    const idx = tabs.findIndex((t) => t.key === key);
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    setTabCwd((prev) => {
      if (!(key in prev)) return prev;
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
    if (activeKey === key) {
      setActiveKey(next.length ? next[Math.min(idx, next.length - 1)].key : "");
    }
  };

  const patchTabState = (key: string, next: ConnStateDto) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? { ...t, state: next } : t)));
  };

  const patchTabId = (key: string, tabId: string) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? { ...t, tabId } : t)));
  };

  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;
  const activeLabel = activeTab?.label ?? "";

  // 自绘标题栏命中区：标签增删、视图/主题/最大化变化后重新量测
  useCaptionHitTest([tabs.map((t) => t.key).join(","), view, railCollapsed, maximized, theme].join("|"));
  const query = railQuery.trim().toLowerCase();
  const savedRows = connections.filter(
    (row) =>
      !query ||
      row.name.toLowerCase().includes(query) ||
      row.host.toLowerCase().includes(query) ||
      row.username.toLowerCase().includes(query),
  );
  const recentRows = sessions
    .filter(
      (s) =>
        !query ||
        s.name.toLowerCase().includes(query) ||
        s.connectionId.toLowerCase().includes(query),
    )
    .slice(0, 6);
  const activeInSaved = savedRows.some((r) => `${r.username}@${r.host}` === activeLabel);

  const terminalTitle = activeTab
    ? `${activeTab.label} · ${STATE_TEXT[activeTab.state.state] ?? activeTab.state.state}`
    : "无活动会话";

  const onTitleBarMouseDown = (ev: ReactMouseEvent) => {
    if (!IS_TAURI || ev.button !== 0) return;
    const el = ev.target as HTMLElement;
    if (el.closest("button,input,select,textarea,a,[role='button']")) return;
    // 系统拖动会接管后续鼠标事件，双击的第二次 mousedown 只能在进入拖动前判断
    if (ev.detail === 2) {
      ev.preventDefault();
      toggleMaximize();
      return;
    }
    void getCurrentWindow().startDragging();
  };

  return (
    <div className={["app", "app--next", resizing ? "app--resizing" : "", maximized ? "app--max" : "", IS_MAC ? "app--mac" : ""].filter(Boolean).join(" ")}>
      <header
        className="topbar"
        onMouseDown={onTitleBarMouseDown}
      >
        <div className="brandmark">
          <img src={theme === "dark" ? brandDark : brandLight} alt="" draggable={false} />
        </div>
        <h1 className="brand">Shellora</h1>
        <nav className="navpills" aria-label="主导航">
          <button
            type="button"
            className={view === "files" ? "navpill on" : "navpill"}
            onClick={() => setView("files")}
          >
            <Icon name="folder" /> Files
          </button>
          <button
            type="button"
            className={view === "files" ? "navpill on" : "navpill"}
            onClick={() => setView("files")}
          >
            <Icon name="terminal" /> Terminal
          </button>
          <button
            type="button"
            className={view === "connect" ? "navpill on" : "navpill"}
            onClick={() => setView("connect")}
          >
            <Icon name="server" /> Connections
          </button>
        </nav>

        <button
          type="button"
          className="iconbtn rail-toggle"
          title={railCollapsed ? "展开会话栏 (Ctrl+B)" : "折叠会话栏 (Ctrl+B)"}
          aria-label={railCollapsed ? "展开会话栏" : "折叠会话栏"}
          aria-pressed={railCollapsed}
          onClick={() => setRailCollapsed((prev) => !prev)}
        >
          <Icon name="sidebar" />
        </button>

        <div className="searchbox">
          <Icon name="search" />
          <input
            value={railQuery}
            onChange={(ev) => setRailQuery(ev.target.value)}
            placeholder="搜索会话、主机或路径"
            aria-label="搜索会话"
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div className="avatar">TZ</div>

        {/* 会话条已并入顶栏：品牌 / 标签 / 传输 / 文件 / 主题在同一行 */}
        <div className="sessionbar sessionbar--inline">
        <button
          type="button"
          className={railCollapsed ? "sb-toggle" : "sb-toggle on"}
          title={railCollapsed ? "展开会话库 (Ctrl+B)" : "收起会话库 (Ctrl+B)"}
          aria-label={railCollapsed ? "展开会话库" : "收起会话库"}
          aria-pressed={!railCollapsed}
          onClick={() => setRailCollapsed((prev) => !prev)}
        >
          <Icon name="sidebar" />
        </button>

        <div className="sb-tabs" role="tablist" aria-label="会话">
          {tabs.length === 0 ? (
            <span className="sb-empty">无活动会话 · 从会话库打开一个连接</span>
          ) : (
            tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={tab.key === activeKey}
                className={tab.key === activeKey ? "sbtab on" : "sbtab"}
                onClick={() => {
                  setActiveKey(tab.key);
                  setView("files");
                }}
              >
                <span className={`dot dot--${tab.state.state}`} aria-hidden />
                <span className="sbtab__t">{tab.label}</span>
                {tab.key === activeKey ? (
                  <span
                    className="sbtab__x"
                    role="button"
                    aria-label="关闭会话"
                    title="关闭会话"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      closeTab(tab.key);
                    }}
                  >
                    <Icon name="x" />
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>

        <span className="grow" />

        {sftpSummary && sftpSummary.active + sftpSummary.queued > 0 ? (
          <button
            type="button"
            className="sb-chip"
            title="打开文件面板查看传输队列"
            onClick={() => {
              setView("files");
              setPanelOpen(true);
            }}
          >
            <Icon name="upload" />
            <b>{sftpSummary.active + sftpSummary.queued}</b>
            <span>传输中</span>
          </button>
        ) : null}

        <button
          type="button"
          className={panelOpen ? "sb-btn sb-btn--icon on" : "sb-btn sb-btn--icon"}
          title="文件面板 (Ctrl+Shift+E)"
          aria-label="文件面板"
          aria-expanded={panelOpen}
          onClick={() => {
            setView("files");
            setPanelOpen((prev) => !prev);
          }}
        >
          <Icon name="folder" />
          <span>文件</span>
        </button>

        {panelOpen ? (
          <button
            type="button"
            className="sb-btn sb-btn--icon"
            title={panelLayout === "push" ? "当前：挤压终端（Alt+P 切换为覆盖）" : "当前：覆盖终端（Alt+P 切换为挤压）"}
            aria-label={panelLayout === "push" ? "当前挤压：切换为覆盖终端" : "当前覆盖：切换为挤压终端"}
            aria-pressed={panelLayout === "push"}
            onClick={() => setPanelLayout((prev) => (prev === "push" ? "overlay" : "push"))}
          >
            <Icon name={panelLayout === "push" ? "columns" : "layers"} />
            <span>{panelLayout === "push" ? "挤压" : "覆盖"}</span>
          </button>
        ) : null}

        <button
          type="button"
          className={view === "connect" ? "sb-btn sb-btn--icon on" : "sb-btn sb-btn--icon"}
          title="新建连接"
          aria-label="新建连接"
          onClick={() => setView(view === "connect" ? "files" : "connect")}
        >
          <Icon name="plus" />
          <span>连接</span>
        </button>
        </div>

        <UpdateButton />
        <button
          type="button"
          className="iconbtn"
          title={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
          onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
        >
          <Icon name={theme === "light" ? "moon" : "sun"} />
        </button>
        <WindowControls maximized={maximized} onToggle={toggleMaximize} hover={maxHover} />
      </header>

      <div
        className={[
          "shellbody",
          railCollapsed ? "shellbody--mini" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <aside className={railCollapsed ? "rail rail--mini" : "rail"}>
          {railCollapsed ? (
            <>
              <div className="mini-head">
                <button
                  type="button"
                  className="mini-add"
                  title="新建连接"
                  aria-label="新建连接"
                  onClick={() => setView("connect")}
                >
                  <Icon name="plus" />
                </button>
              </div>
              <div className="mini-list">
                {savedRows.map((row) => {
                  const live = tabs.find(
                    (t) => t.label === `${row.username}@${row.host}` && t.state.state === "ready",
                  );
                  const connecting = tabs.find(
                    (t) =>
                      t.label === `${row.username}@${row.host}` && t.state.state === "connecting",
                  );
                  const active = activeTab?.label === `${row.username}@${row.host}`;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={active ? "minirow on" : "minirow"}
                      title={`${row.name} · ${row.username}@${row.host}:${row.port}`}
                      onClick={() => openConnection(row)}
                    >
                      <span className="mini-tile">{row.name.trim().slice(0, 1).toUpperCase()}</span>
                      <span
                        className={live ? "mini-st" : connecting ? "mini-st warn" : "mini-st off"}
                      />
                    </button>
                  );
                })}
                {savedRows.length === 0 ? (
                  <span className="mini-empty" title="暂无已保存会话">
                    <Icon name="server" />
                  </span>
                ) : null}
                {recentRows.length > 0 ? <span className="mini-sep" aria-hidden /> : null}
                {recentRows.slice(0, 4).map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={
                      !activeInSaved && activeLabel === row.name ? "minirow on" : "minirow"
                    }
                    title={`最近会话 · ${row.name}`}
                    onClick={() => openSession(row)}
                  >
                    <span className="mini-tile ghost">
                      <Icon name="clock" />
                    </span>
                  </button>
                ))}
              </div>
              <div className="mini-foot">
                <button
                  type="button"
                  className="mini-add"
                  title="展开会话栏 (Ctrl+B)"
                  aria-label="展开会话栏"
                  onClick={() => setRailCollapsed(false)}
                >
                  <Icon name="chevronLeft" />
                </button>
              </div>
            </>
          ) : null}
          {railCollapsed ? null : (
            <>
              <div className="rail-head">
            <h2>Sessions</h2>
            <span className="count">{connections.length}</span>
            <span className="grow" />
            <button
              type="button"
              className="add"
              title="新建连接"
              onClick={() => setView("connect")}
            >
              <Icon name="plus" />
            </button>
          </div>

          <div className="seg" role="tablist" aria-label="会话筛选">
            {(
              [
                ["all", "全部"],
                ["saved", "已保存"],
                ["recent", "最近"],
              ] as Array<[RailTab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={railTab === key ? "on" : ""}
                onClick={() => setRailTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="railsearch">
            <Icon name="search" />
            <input
              value={railQuery}
              onChange={(ev) => setRailQuery(ev.target.value)}
              placeholder="筛选会话"
              aria-label="筛选会话"
            />
          </div>

          <div className="rail-scroll" ref={railScrollRef}>
            {railTab !== "recent" ? (
              <>
                <div className="glabel">
                  会话库 <span className="n">{savedRows.length}</span>
                </div>
                {savedRows.length === 0 ? (
                  <p className="hint" style={{ padding: "0 8px" }}>
                    暂无已保存连接，点右上角 + 新建。
                  </p>
                ) : (
                  savedRows.map((row) => {
                    const live = tabs.find(
                      (t) => t.label === `${row.username}@${row.host}` && t.state.state === "ready",
                    );
                    const connecting = tabs.find(
                      (t) =>
                        t.label === `${row.username}@${row.host}` &&
                        t.state.state === "connecting",
                    );
                    const isActive = activeLabel === `${row.username}@${row.host}`;
                    return (
                      <div
                        key={row.id}
                        ref={isActive ? activeRailRowRef : undefined}
                        className={[
                          "srow",
                          isActive ? "on" : "",
                          isActive && railPulse ? "pulse" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <span className="tile prod">
                          <Icon name="server" />
                        </span>
                        <button
                          type="button"
                          className="tx"
                          style={{ border: 0, background: "transparent", textAlign: "left" }}
                          onClick={() => openConnection(row)}
                          title="点击连接"
                        >
                          <span className="nm">{row.name}</span>
                          <span className="mt">
                            {row.username}@{row.host}:{row.port}
                          </span>
                        </button>
                        <span
                          className={
                            live ? "st" : connecting ? "st warn" : "st off"
                          }
                        />
                        <button
                          type="button"
                          className="srow__x"
                          title="载入到表单"
                          onClick={() => selectConnection(row)}
                        >
                          <Icon name="pencil" />
                        </button>
                        <button
                          type="button"
                          className="srow__x"
                          title="删除连接"
                          onClick={() => void removeConnection(row)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    );
                  })
                )}
              </>
            ) : null}

            {railTab !== "saved" && recentRows.length > 0 ? (
              <>
                <div className="glabel" style={{ marginTop: 12 }}>
                  最近会话 <span className="n">{recentRows.length}</span>
                </div>
                {recentRows.map((row) => {
                  const isActive = !activeInSaved && activeLabel === row.name;
                  return (
                    <div
                      key={row.id}
                      ref={isActive ? activeRailRowRef : undefined}
                      className={[
                        "srow",
                        isActive ? "on" : "",
                        isActive && railPulse ? "pulse" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <span className="tile">
                        <Icon name="clock" />
                      </span>
                      <button
                        type="button"
                        className="tx"
                        style={{ border: 0, background: "transparent", textAlign: "left" }}
                        onClick={() => openSession(row)}
                      >
                        <span className="nm">{row.name}</span>
                        <span className="mt">恢复该会话</span>
                      </button>
                    </div>
                  );
                })}
              </>
            ) : null}
          </div>

          <div className="rail-foot">
            <button type="button" className="newcon" onClick={() => setView("connect")}>
              <Icon name="plus" /> 新建连接
            </button>
            <div className="usercard">
              <DataResetButton />
              <TraySettings />
              <span className="grow" />
              <span>{theme === "light" ? "Light" : "Dark"}</span>
            </div>
          </div>
            </>
          )}
        </aside>
        {!railCollapsed ? (
          <button
            type="button"
            className="railscrim"
            aria-label="收起会话库"
            onClick={() => setRailCollapsed(true)}
          />
        ) : null}

        <main
          className="center center--stage"
          data-panel={panelOpen ? "open" : "closed"}
          data-layout={panelLayout}
        >
          <div className="connectbg" hidden={view !== "connect"}>
              <div className="connpage">
                <div className="conntop">
                  <button type="button" className="back" onClick={() => setView("files")}>
                    <Icon name="chevronLeft" /> Files
                  </button>
                  <span className="sep">/</span>
                  <span className="ttl">New connection</span>
                  <span className="grow" />
                  <span className="hint">SSH · SFTP · 代理 · 跳板链</span>
                </div>

                <div className="connbody">
                  <form className="editor2" onSubmit={submit}>
                    <header className="ehead2">
                      <span className="mark">
                        <Icon name="server" />
                      </span>
                      <div>
                        <div className="nm">{form.name || "未命名连接"}</div>
                        <div className="sub">
                          {form.username || "user"}@{form.host || "host"}:
                          {form.port || "22"}
                        </div>
                      </div>
                      <span className="grow" />
                      <span className="warnchip">
                        <Icon name="lock" /> 密码不落盘
                      </span>
                    </header>

                    <div className="form2">
                      <section className="fsec2">
                        <div className="sh2">
                          <span className="lbl2">Endpoint</span>
                          <span className="rule2" />
                          <span className="hint2">名称仅用于本地会话库</span>
                        </div>
                        <div className="g2">
                          <label className="field2">
                            <span className="lb2">名称</span>
                            <input
                              className="in2"
                              value={form.name}
                              onChange={patch("name")}
                              autoComplete="off"
                            />
                          </label>
                          <label className="field2">
                            <span className="lb2">
                              主机 <span className="req">*</span>
                            </span>
                            <input
                              className="in2"
                              value={form.host}
                              onChange={patch("host")}
                              autoComplete="off"
                              placeholder="host / IP"
                            />
                          </label>
                          <label className="field2">
                            <span className="lb2">端口</span>
                            <input
                              className="in2"
                              value={form.port}
                              onChange={patch("port")}
                              inputMode="numeric"
                            />
                          </label>
                          <label className="field2">
                            <span className="lb2">
                              用户名 <span className="req">*</span>
                            </span>
                            <input
                              className="in2"
                              value={form.username}
                              onChange={patch("username")}
                              autoComplete="off"
                            />
                          </label>
                        </div>
                      </section>

                      <section className="fsec2">
                        <div className="sh2">
                          <span className="lbl2">Authentication</span>
                          <span className="rule2" />
                        </div>
                        <div className="g2">
                          <label className="field2">
                            <span className="lb2">认证方式</span>
                            <select
                              className="in2"
                              value={form.authMode}
                              onChange={patch("authMode")}
                            >
                              <option value="password">密码</option>
                              <option value="key">私钥文件</option>
                              <option value="agent">ssh-agent</option>
                            </select>
                          </label>
                          {form.authMode === "password" ? (
                            <label className="field2">
                              <span className="lb2">
                                密码 <span className="opt">仅本次会话</span>
                              </span>
                              <input
                                className="in2"
                                type="password"
                                value={form.password}
                                onChange={patch("password")}
                                autoComplete="off"
                              />
                            </label>
                          ) : null}
                          {form.authMode === "key" ? (
                            <>
                              <label className="field2">
                                <span className="lb2">私钥路径</span>
                                <input
                                  className="in2"
                                  value={form.keyPath}
                                  onChange={patch("keyPath")}
                                  autoComplete="off"
                                  placeholder="OpenSSH / PEM / PPK"
                                />
                              </label>
                              <label className="field2">
                                <span className="lb2">
                                  私钥口令 <span className="opt">可空</span>
                                </span>
                                <input
                                  className="in2"
                                  type="password"
                                  value={form.keyPassphrase}
                                  onChange={patch("keyPassphrase")}
                                  autoComplete="off"
                                />
                              </label>
                            </>
                          ) : null}
                          {form.authMode === "agent" ? (
                            <>
                              <label className="field2">
                                <span className="lb2">
                                   agent 端点 <span className="opt">空=系统默认</span>
                                </span>
                                <input
                                  className="in2"
                                  value={form.agentSocket}
                                  onChange={patch("agentSocket")}
                                  autoComplete="off"
                                />
                              </label>
                              <label className="field2">
                                <span className="lb2">
                                  identity <span className="opt">空=第一个</span>
                                </span>
                                <input
                                  className="in2"
                                  value={form.agentKey}
                                  onChange={patch("agentKey")}
                                  autoComplete="off"
                                />
                              </label>
                            </>
                          ) : null}
                        </div>
                      </section>

                      <section className="fsec2">
                        <div className="sh2">
                          <span className="lbl2">Proxy</span>
                          <span className="rule2" />
                          <span className="hint2">可选，经代理转发 TCP</span>
                        </div>
                        <div className="g2">
                          <label className="field2">
                            <span className="lb2">类型</span>
                            <select
                              className="in2"
                              value={form.proxyKind}
                              onChange={patch("proxyKind")}
                            >
                              <option value="none">不使用</option>
                              <option value="socks5">SOCKS5</option>
                              <option value="httpConnect">HTTP CONNECT</option>
                            </select>
                          </label>
                          {form.proxyKind !== "none" ? (
                            <>
                              <label className="field2">
                                <span className="lb2">代理主机</span>
                                <input
                                  className="in2"
                                  value={form.proxyHost}
                                  onChange={patch("proxyHost")}
                                  autoComplete="off"
                                />
                              </label>
                              <label className="field2">
                                <span className="lb2">端口</span>
                                <input
                                  className="in2"
                                  value={form.proxyPort}
                                  onChange={patch("proxyPort")}
                                  inputMode="numeric"
                                />
                              </label>
                              <label className="field2">
                                <span className="lb2">
                                  用户名 <span className="opt">可空</span>
                                </span>
                                <input
                                  className="in2"
                                  value={form.proxyUser}
                                  onChange={patch("proxyUser")}
                                  autoComplete="off"
                                />
                              </label>
                              <label className="field2">
                                <span className="lb2">
                                  密码 <span className="opt">可空</span>
                                </span>
                                <input
                                  className="in2"
                                  type="password"
                                  value={form.proxyPass}
                                  onChange={patch("proxyPass")}
                                  autoComplete="off"
                                />
                              </label>
                            </>
                          ) : null}
                        </div>
                      </section>

                      <section className="fsec2">
                        <div className="sh2">
                          <span className="lbl2">Jump chain</span>
                          <span className="rule2" />
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() =>
                              setJumps((prev) => [
                                ...prev,
                                { host: "", port: "22", username: "", password: "" },
                              ])
                            }
                          >
                            <Icon name="plus" /> 添加跳板
                          </button>
                        </div>
                        {jumps.length === 0 ? (
                          <p className="hint2">无跳板，直连目标。</p>
                        ) : null}
                        {jumps.map((j, idx) => (
                          <div className="g2" key={idx} style={{ marginBottom: 10 }}>
                            <label className="field2">
                              <span className="lb2">跳板 {idx + 1} 主机</span>
                              <input
                                className="in2"
                                value={j.host}
                                onChange={(ev) =>
                                  setJumps((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, host: ev.target.value } : it,
                                    ),
                                  )
                                }
                                autoComplete="off"
                              />
                            </label>
                            <label className="field2">
                              <span className="lb2">端口</span>
                              <input
                                className="in2"
                                value={j.port}
                                inputMode="numeric"
                                onChange={(ev) =>
                                  setJumps((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, port: ev.target.value } : it,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label className="field2">
                              <span className="lb2">用户名</span>
                              <input
                                className="in2"
                                value={j.username}
                                onChange={(ev) =>
                                  setJumps((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, username: ev.target.value } : it,
                                    ),
                                  )
                                }
                                autoComplete="off"
                              />
                            </label>
                            <label className="field2">
                              <span className="lb2">密码</span>
                              <input
                                className="in2"
                                type="password"
                                value={j.password}
                                onChange={(ev) =>
                                  setJumps((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, password: ev.target.value } : it,
                                    ),
                                  )
                                }
                                autoComplete="off"
                              />
                            </label>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => setJumps((prev) => prev.filter((_, i) => i !== idx))}
                            >
                              移除
                            </button>
                          </div>
                        ))}
                      </section>
                    </div>

                    <footer className="efoot2">
                      {message ? (
                        <span className={message.tone === "warn" ? "warn" : "test"}>
                          {message.tone === "warn" ? <Icon name="alert" /> : <Icon name="check" />}
                          {message.text}
                        </span>
                      ) : (
                        <span className="hint2">密码按 D1 不入库，每次连接输入。</span>
                      )}
                      <span className="grow" />
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void testConnection()}
                        disabled={busy}
                      >
                        测试
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void saveConnection()}
                        disabled={busy}
                      >
                        保存
                      </button>
                      <button type="submit" className="btn btn--primary" disabled={busy}>
                        <Icon name="zap" /> 连接
                      </button>
                    </footer>
                  </form>

                  <aside className="hkcol">
                    <div className="hklabel">
                      Security <span className="ln" />
                    </div>
                    <div className="scard">
                      <div className="sh">
                        <Icon name="shield" /> 主机密钥校验
                      </div>
                      <p className="hknote">
                        首次连接会拦截未知主机并要求核对 SHA256 指纹；指纹变更时不会提供“永久信任”，只能人工核对后删除旧记录重连。
                      </p>
                    </div>
                    <div className="scard">
                      <div className="sh">
                        <Icon name="key" /> 凭据
                      </div>
                      <p className="hknote">
                        密码仅本次会话使用，不写入数据库；私钥口令同样不落盘。系统钥匙串不可用时会在此提示。
                      </p>
                      {probe && probe.backend === "none" ? (
                        <p className="warn" style={{ marginTop: 8 }}>
                          未检测到系统钥匙串，按 D1 不会把密码落盘；请安装 libsecret。
                        </p>
                      ) : null}
                    </div>
                    <div className="scard">
                      <div className="sh">
                        <Icon name="terminal" /> 夹具联调
                      </div>
                      <p className="hknote">
                        <span className="mono">
                          cargo run --features fixture --bin fixture_sshd
                        </span>
                        <br />
                        默认 alice / secret，端口 2222。
                      </p>
                    </div>
                    {sessions.length > 0 ? (
                      <div className="scard">
                        <div className="sh">
                          <Icon name="clock" /> 最近会话
                        </div>
                        {sessions.slice(0, 4).map((s) => (
                          <div className="frowx" key={s.id}>
                            <span className="nm ell">{s.name}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </aside>
                </div>
              </div>
            </div>
          <>
            <aside
              className={panelWidth && panelWidth < 420 ? "drawer drawer--compact" : "drawer"}
              aria-label="文件面板"
              aria-hidden={panelOpen ? "false" : "true"}
            >
              <div
                className="drawer__grip"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整文件面板宽度"
                aria-valuemin={340}
                aria-valuemax={720}
                aria-valuenow={Math.round(panelWidth)}
                title="拖动调整宽度 · 双击恢复默认 · Alt+[ / Alt+] 微调"
                tabIndex={0}
                onPointerDown={startResize}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onDoubleClick={() => setPanelWidth(clampPanelWidth(defaultPanelWidth()))}
                onKeyDown={(ev) => {
                  if (ev.key === "ArrowLeft") {
                    ev.preventDefault();
                    nudgePanelWidth(1, ev.shiftKey ? 120 : 40);
                  } else if (ev.key === "ArrowRight") {
                    ev.preventDefault();
                    nudgePanelWidth(-1, ev.shiftKey ? 120 : 40);
                  } else if (ev.key === "Home") {
                    ev.preventDefault();
                    setPanelWidth(clampPanelWidth(defaultPanelWidth()));
                  }
                }}
              />
              {resizing ? (
                <div
                  className="drawer__wbar"
                  aria-hidden="true"
                  style={{
                    left: Math.max(8, window.innerWidth - 8 - Math.round(panelWidth) - 52),
                    top: 96,
                  }}
                >
                  {Math.round(panelWidth)}px
                </div>
              ) : null}
              <div className="drawer__head">
                <Icon name="folder" />
                <b>文件</b>
                <span className="drawer__host">{activeTab?.label ?? "未连接"}</span>
                <span className="grow" />
                <span className="drawer__w">{Math.round(panelWidth)}px</span>
                <button
                  type="button"
                  className="drawer__x"
                  aria-label="收起文件面板"
                  title="收起 (Ctrl+Shift+E)"
                  onClick={() => setPanelOpen(false)}
                >
                  <Icon name="x" />
                </button>
              </div>
              <div className="drawer__body">
                <SftpManager
                  tabId={activeTab?.tabId ?? null}
                  label={activeTab?.label ?? "未连接"}
                  initialRemotePath={activeTab ? tabCwd[activeTab.key] ?? null : null}
                  onSummary={setSftpSummary}
                  onOpenTerminal={() => setPanelOpen(false)}
                  active={panelOpen}
                />
              </div>
            </aside>

            <section
              className="termcard open termcard--stage"
              data-drop={dropOver ? "1" : "0"}
              onDragOver={onTermDragOver}
              onDragLeave={() => setDropOver(false)}
              onDrop={onTermDrop}
            >
                <div className="termbar">
                  <span className="htile">
                    <Icon name="terminal" />
                  </span>
                  <span className="nm">Terminal</span>
                  <span className="meta">{terminalTitle}</span>
                  {tabs.length > 0 ? (
                    <span className="meta">
                      · {tabs.length}/{MAX_TABS}
                    </span>
                  ) : null}
                  <span className="grow" />
                  {message ? (
                    <span className={message.tone === "warn" ? "warn" : "meta"}>
                      {message.text}
                    </span>
                  ) : null}
                </div>

                <div className="termbody">
                  {tabs.length > 0 ? (
                    <div className="termtabs">
                      {tabs.map((tab) => (
                        <div
                          key={tab.key}
                          className={tab.key === activeKey ? "termtab on" : "termtab"}
                        >
                          <button
                            type="button"
                            className="termtab__label"
                            onClick={() => setActiveKey(tab.key)}
                          >
                            <span className={`dot dot--${tab.state.state}`} aria-hidden />
                            <span className="termtab__text">{tab.label}</span>
                          </button>
                          <button
                            type="button"
                            className="termtab__close"
                            aria-label="关闭标签"
                            onClick={() => closeTab(tab.key)}
                          >
                            <Icon name="x" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="iconbtn"
                        title="新建连接"
                        onClick={() => setView("connect")}
                      >
                        <Icon name="plus" />
                      </button>
                    </div>
                  ) : null}
                  <div className="panes">
                    {tabs.length === 0 ? (
                      <div className="empty2">
                        <Icon name="terminal" />
                        <b>暂无终端会话</b>
                        <span>在左侧会话库打开连接，或新建一个 SSH 连接。</span>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => setView("connect")}
                        >
                          <Icon name="plus" /> 新建连接
                        </button>
                      </div>
                    ) : null}
                    {tabs.map((tab, index) => (
                      <TerminalPane
                        key={tab.key}
                        input={tab.input}
                        active={tab.key === activeKey}
                        tabIndex={index + 1}
                        onStateChange={(next) => patchTabState(tab.key, next)}
                        onTabId={(tabId) => patchTabId(tab.key, tabId)}
                        onCwd={(cwd) =>
                          setTabCwd((prev) =>
                            prev[tab.key] === cwd ? prev : { ...prev, [tab.key]: cwd },
                          )
                        }
                        onOpenFiles={() => {
                          setView("files");
                        }}
                      />
                    ))}
                  </div>
                </div>
              </section>
          </>
        </main>

        {view === "files" ? (
          <aside className="rightrail">
            <div className="scard">
              <div className="sh">
                <Icon name="server" /> Connection
                <Icon name="more" className="more" />
              </div>
              {activeTab ? (
                <div className="facts">
                  <div className="fact">
                    <div className="k">Host</div>
                    <div className="v">{activeTab.input.host}</div>
                  </div>
                  <div className="fact">
                    <div className="k">Port</div>
                    <div className="v">{activeTab.input.port}</div>
                  </div>
                  <div className="fact">
                    <div className="k">User</div>
                    <div className="v">{activeTab.input.username}</div>
                  </div>
                  <div className="fact">
                    <div className="k">Auth</div>
                    <div className="v">{authLabel(activeTab.input)}</div>
                  </div>
                  <div className="fact">
                    <div className="k">State</div>
                    <div className="v">{STATE_TEXT[activeTab.state.state] ?? activeTab.state.state}</div>
                  </div>
                  <div className="fact">
                    <div className="k">Jump</div>
                    <div className="v">
                      {(activeTab.input.jumps?.length ?? 0) > 0
                        ? `${activeTab.input.jumps?.length} hop`
                        : "none"}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="hint">尚未选择会话。</p>
              )}
            </div>

            <div className="scard xfercard">
              <div className="sh">
                <Icon name="upload" /> Live transfer
                <span className="more">{sftpSummary?.active ?? 0} active</span>
              </div>
              {sftpSummary?.current ? (
                <>
                  <div className="file">
                    <span className="ftile">
                      <Icon name="file" />
                    </span>
                    <span className="nmx">{sftpSummary.current.name}</span>
                  </div>
                  <div className="prog">
                    <i style={{ width: `${sftpSummary.current.percent}%` }} />
                  </div>
                  <div className="xmeta">
                    <b>{sftpSummary.current.mbps.toFixed(2)} MiB/s</b>
                    <span>{Math.round(sftpSummary.current.percent)}%</span>
                    <span className="grow" />
                    <span>ETA {sftpSummary.current.eta}</span>
                  </div>
                </>
              ) : (
                <p className="hint">
                  队列空闲。已排队 {sftpSummary?.queued ?? 0} · 已完成 {sftpSummary?.done ?? 0}。
                </p>
              )}
            </div>

            <div className="scard recent">
              <div className="sh">
                <Icon name="clock" /> Recent files
              </div>
              {sftpSummary && sftpSummary.recent.length > 0 ? (
                sftpSummary.recent.map((item, idx) => (
                  <div className="frowx" key={`${item.name}-${idx}`}>
                    <span className={`ftile ${item.direction === "upload" ? "tint-blue" : "tint-teal"}`}>
                      <Icon name="file" />
                    </span>
                    <span className="nm">{item.name}</span>
                    <span className="sz">{item.size > 0 ? `${(item.size / 1024).toFixed(0)} KB` : "—"}</span>
                  </div>
                ))
              ) : (
                <p className="hint">完成传输后会在这里列出最近文件。</p>
              )}
            </div>
          </aside>
        ) : null}
      </div>

      <footer className="statusbar">
        <span className="cell">
          <span className={activeTab?.state.state === "ready" ? "dot" : "dot off"} />
          <b>{terminalTitle}</b>
        </span>
        <span className="cell">
          本地 <b className="num">{(sftpSummary?.active ?? 0) + (sftpSummary?.queued ?? 0)}</b> 个传输
        </span>
        <span className="cell">
          SFTP <b className="num">{sftpSummary?.done ?? 0}</b> 已完成
        </span>
        <span className="cell">
          <b>
            {panelOpen
              ? `文件面板 · ${panelLayout === "push" ? "挤压中" : "覆盖中"} · ${Math.round(panelWidth)}px`
              : "文件面板已收起"}
          </b>
        </span>
        <span className="cell">{message ? message.text : "玻璃拟态关闭 · 实色面板"}</span>
        <span className="grow" />
        <span className="cell">{theme === "light" ? "LIGHT" : "DARK"}</span>
        <span className="cell">Shellora {appVersion ? `v${appVersion}` : "dev"}</span>
      </footer>

      {hostKeyPrompt ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h3 className="modal__title">
              {hostKeyPrompt.kind === "unknown"
                ? "首次连接：确认为可信主机"
                : "警告：主机密钥已变更"}
            </h3>
            <dl className="fingerprint">
              <dt>主机</dt>
              <dd>
                {hostKeyPrompt.details.host}:{hostKeyPrompt.details.port}
              </dd>
              <dt>密钥类型</dt>
              <dd>{hostKeyPrompt.details.keyType}</dd>
              <dt>SHA256（默认）</dt>
              <dd className="mono">{hostKeyPrompt.details.fingerprintSha256}</dd>
              <dt>MD5</dt>
              <dd className="mono">{hostKeyPrompt.details.fingerprintMd5}</dd>
              {hostKeyPrompt.details.known?.length ? (
                <>
                  <dt>已信任</dt>
                  <dd className="mono">
                    {hostKeyPrompt.details.known
                      .map((k) => `${k.keyType} ${k.fingerprintSha256}`)
                      .join("\n")}
                  </dd>
                </>
              ) : null}
            </dl>
            {hostKeyPrompt.kind === "unknown" ? (
              <p className="hint">
                请与目标主机的运维方核对指纹。确认后该指纹写入本地信任库；不确认则不会建立会话。
              </p>
            ) : (
              <p className="warn">
                这可能意味着中间人攻击或主机密钥被替换。本工具不会提供“永久信任”，
                请先人工核对，再删除该主机记录并重新连接。
              </p>
            )}
            <div className="form__actions">
              <button type="button" className="btn" onClick={() => setHostKeyPrompt(null)}>
                取消
              </button>
              {hostKeyPrompt.kind === "unknown" ? (
                <button type="button" className="btn btn--primary" onClick={trustNewHost} disabled={busy}>
                  信任并继续
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => void deleteBlockedHost()} disabled={busy}>
                  删除该主机记录
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {trayToast ? (
        <div className="tray-toast" role="status">
          <Icon name="check" />
          {trayToast}
        </div>
      ) : null}

      <ResizeHandles enabled={!maximized} />
    </div>
  );
}
