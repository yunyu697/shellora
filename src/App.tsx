import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";

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
import { applyUiTheme, loadUiTheme, storeUiTheme, type UiTheme } from "./theme";

const MAX_TABS = 30;
const RAIL_KEY = "shellora.railCollapsed";

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
const previewTerminal = Boolean(
  (window as unknown as { __SHELLORA_PREVIEW_TERMINAL__?: boolean }).__SHELLORA_PREVIEW_TERMINAL__,
);

export default function App() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [jumps, setJumps] = useState<JumpForm[]>([]);
  const [probe, setProbe] = useState<SecretProbeDto | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
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
  const [terminalOpen, setTerminalOpen] = useState(previewTerminal);
  const [railTab, setRailTab] = useState<RailTab>("all");
  const [railQuery, setRailQuery] = useState("");
  const [railCollapsed, setRailCollapsed] = useState<boolean>(loadRailCollapsed);
  const [railPulse, setRailPulse] = useState(false);
  const [sftpSummary, setSftpSummary] = useState<SftpSummary | null>(null);
  const seqRef = useRef(0);
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const activeRailRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    applyUiTheme(theme, document.documentElement);
    storeUiTheme(theme, window.localStorage);
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_KEY, railCollapsed ? "1" : "0");
    } catch {
      /* 隐私模式忽略 */
    }
  }, [railCollapsed]);

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brandmark">
          <Icon name="terminal" />
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
            className={view === "files" && terminalOpen ? "navpill on" : "navpill"}
            onClick={() => {
              setView("files");
              setTerminalOpen(true);
            }}
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
          <Icon name={railCollapsed ? "chevronRight" : "panel"} />
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
        <UpdateButton />
        <button
          type="button"
          className="iconbtn"
          title={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
          onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
        >
          <Icon name={theme === "light" ? "moon" : "sun"} />
        </button>
        <div className="avatar">TZ</div>
      </header>

      <div
        className={[
          "shellbody",
          terminalOpen && view === "files" ? "shellbody--with-rail" : "",
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
              <span className="grow" />
              <span>{theme === "light" ? "Light" : "Dark"}</span>
            </div>
          </div>
            </>
          )}
        </aside>

        <main className={terminalOpen ? "center center--split" : "center"}>
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
            <SftpManager
                tabId={activeTab?.tabId ?? null}
                label={activeTab?.label ?? "未连接"}
                initialRemotePath={activeTab ? tabCwd[activeTab.key] ?? null : null}
                onSummary={setSftpSummary}
                onOpenTerminal={() => setTerminalOpen(true)}
              />

              <section className={terminalOpen ? "termcard open" : "termcard closed"}>
                <button
                  type="button"
                  className="termbar"
                  onClick={() => setTerminalOpen((prev) => !prev)}
                  aria-expanded={terminalOpen}
                >
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
                  <span className="thbtn">
                    {terminalOpen ? "收起" : "展开"}
                    <Icon name={terminalOpen ? "chevronDown" : "chevronUp"} />
                  </span>
                </button>

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
                        active={tab.key === activeKey && terminalOpen}
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
                          setTerminalOpen(false);
                        }}
                      />
                    ))}
                  </div>
                </div>
              </section>
          </>
        </main>

        {terminalOpen && view === "files" ? (
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
          <b>{terminalOpen ? "上下分栏" : "终端已收起"}</b>
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
    </div>
  );
}
