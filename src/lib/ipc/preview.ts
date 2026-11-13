// 仅供本地视觉回归：`pnpm dev` 后带 ?preview=1 打开，用固定夹具替代 Rust IPC。
// 不进入生产运行路径（main.tsx 仅在 URL 显式要求时挂载），也不改变任何 IPC 契约。

import type { ConnectionRow, DirEntry, SessionRow, TransferTask } from "./types";

const LOCAL_ROOT = "C:\\Users\\demo\\Projects\\shellora";
const REMOTE_ROOT = "/var/www/shellora";

const NAMES: Array<[string, boolean, number, number]> = [
  ["dist", true, 0, 42],
  ["src", true, 0, 41],
  ["docs", true, 0, 39],
  ["scripts", true, 0, 38],
  ["node_modules", true, 0, 37],
  ["package.json", false, 4820, 36],
  ["pnpm-lock.yaml", false, 218_400, 35],
  ["README.md", false, 18_240, 34],
  ["tsconfig.json", false, 1240, 33],
  ["vite.config.ts", false, 860, 32],
  ["shellora-1.0.0.zip", false, 96_420_000, 31],
  ["screenshot-main.png", false, 2_480_000, 30],
  ["access.log", false, 1_204_800, 29],
  ["bundle.log", false, 84_200, 28],
  ["theme.toml", false, 640, 27],
  ["notes.md", false, 3_120, 26],
];

function makeEntries(root: string, remote: boolean): DirEntry[] {
  const base = Date.now();
  return NAMES.map(([name, isDir, size, ago], index) => ({
    name,
    path: remote ? `${root}/${name}` : `${root}\\${name}`,
    isDir,
    isSymlink: false,
    size,
    mtime: base - ago * 3_600_000 - index * 60_000,
  }));
}

const localEntries = makeEntries(LOCAL_ROOT, false);
const remoteEntries = makeEntries(REMOTE_ROOT, true);

const connections: ConnectionRow[] = [
  {
    id: "c-prod",
    name: "Production · web-01",
    host: "10.0.2.42",
    port: 22,
    username: "deploy",
    authKind: "password",
    credentialRefId: null,
    proxyMode: "none",
    keepaliveMs: 30_000,
    connectTimeoutMs: 15_000,
    compression: true,
    createdAt: Date.now() - 86_400_000 * 40,
    updatedAt: Date.now() - 3_600_000,
  },
  {
    id: "c-stage",
    name: "Staging · node-03",
    host: "10.0.2.31",
    port: 2222,
    username: "alice",
    authKind: "password",
    credentialRefId: null,
    proxyMode: "none",
    keepaliveMs: 30_000,
    connectTimeoutMs: 15_000,
    compression: true,
    createdAt: Date.now() - 86_400_000 * 12,
    updatedAt: Date.now() - 86_400_000,
  },
  {
    id: "c-fixture",
    name: "本地夹具",
    host: "127.0.0.1",
    port: 2222,
    username: "alice",
    authKind: "password",
    credentialRefId: null,
    proxyMode: "none",
    keepaliveMs: 30_000,
    connectTimeoutMs: 15_000,
    compression: true,
    createdAt: Date.now() - 86_400_000 * 4,
    updatedAt: Date.now() - 86_400_000 * 2,
  },
];

const sessions: SessionRow[] = [
  {
    id: "s-1",
    connectionId: "c-prod",
    name: "deploy@10.0.2.42",
    groupId: null,
    terminalProfileId: null,
    colorTag: null,
    sortOrder: 0,
    lastUsedAt: Date.now() - 3_600_000,
    createdAt: Date.now() - 86_400_000 * 30,
    updatedAt: Date.now() - 3_600_000,
  },
  {
    id: "s-2",
    connectionId: "c-stage",
    name: "alice@10.0.2.31",
    groupId: null,
    terminalProfileId: null,
    colorTag: null,
    sortOrder: 1,
    lastUsedAt: Date.now() - 86_400_000,
    createdAt: Date.now() - 86_400_000 * 9,
    updatedAt: Date.now() - 86_400_000,
  },
];

function task(
  id: string,
  name: string,
  direction: "upload" | "download",
  state: TransferTask["state"],
  progress: number,
  total: number,
): TransferTask {
  return {
    id,
    direction,
    localPath: direction === "upload" ? `${LOCAL_ROOT}\\${name}` : `${LOCAL_ROOT}\\${name}`,
    remotePath: `${REMOTE_ROOT}/${name}`,
    total,
    transferred: Math.round(total * progress),
    resumedBytes: 0,
    state,
    mbps: state === "running" ? 12.48 : 0,
    etaSecs: state === "running" ? 14 : null,
    errorCode: null,
    message: null,
    groupId: null,
  } as TransferTask;
}

function queue(conflict: boolean): TransferTask[] {
  const list = [
    task("t1", "shellora-1.0.0.zip", "upload", "running", 0.62, 96_420_000),
    task("t2", "screenshot-main.png", "upload", "running", 0.18, 2_480_000),
    task("t3", "access.log", "download", "paused", 0.44, 1_204_800),
    task("t4", "theme.toml", "upload", "done", 1, 640),
  ];
  if (conflict) {
    list.splice(2, 0, task("tc", "notes.md", "upload", "conflict", 0.3, 3_120));
  }
  return list;
}

const preview = new URLSearchParams(window.location.search);
const conflictMode = preview.get("conflict") === "1";

const previewTab = {
  key: "tab-preview",
  input: {
    host: "10.0.2.42",
    port: 22,
    username: "deploy",
    cols: 80,
    rows: 24,
    password: "",
    jumps: [],
  },
  label: "deploy@10.0.2.42",
  state: { state: "ready", reason: null },
  tabId: "preview-tab",
};

(window as unknown as Record<string, unknown>).__SHELLORA_PREVIEW_TAB__ = previewTab;
(window as unknown as Record<string, unknown>).__SHELLORA_PREVIEW_CWD__ = REMOTE_ROOT;
if (preview.get("view") === "connect") {
  (window as unknown as Record<string, unknown>).__SHELLORA_PREVIEW_VIEW__ = "connect";
}
if (preview.get("theme") === "dark") {
  window.localStorage.setItem("shellora.uiTheme", "dark");
}
if (preview.get("rail") === "collapsed") {
  window.localStorage.setItem("shellora.railCollapsed", "1");
}
if (preview.get("terminal") === "1") {
  (window as unknown as Record<string, unknown>).__SHELLORA_PREVIEW_TERMINAL__ = true;
}

function listDir(path: string): { path: string; entries: DirEntry[]; hasMore: boolean; nextOffset: number } {
  const entries = path.startsWith(REMOTE_ROOT) ? remoteEntries : localEntries;
  return { path, entries, hasMore: false, nextOffset: entries.length };
}

interface Internals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (cb: (payload: unknown) => void) => number;
  unregisterCallback: (id: number) => void;
}

const internals: Internals = {
  transformCallback: () => 0,
  unregisterCallback: () => undefined,
  invoke: async (cmd, args = {}) => {
    switch (cmd) {
      case "secret_probe":
        return { backend: "keyring", detail: "视觉预览夹具" };
      case "db_list_connections":
        return connections;
      case "db_list_sessions":
        return sessions;
      case "local_home":
        return LOCAL_ROOT;
      case "local_list_dir":
        return listDir(String(args.path ?? LOCAL_ROOT));
      case "local_stat": {
        const p = String(args.path ?? "");
        const local = localEntries.find((e) => e.path === p);
        const remote = remoteEntries.find((e) => e.path === p);
        const e = local ?? remote;
        let result;
        if (e) {
          result = { isDir: e.isDir, isSymlink: false, size: e.size };
        } else {
          const base = p.split(/[\\/]/).pop() ?? "";
          result = { isDir: !base.includes("."), isSymlink: false, size: 0 };
        }
        const log = ((window as unknown as Record<string, unknown>).__PREVIEW_OPS__ ??= []) as Array<
          Record<string, unknown>
        >;
        log.push({ cmd: "local_stat", path: p, result });
        return result;
      }
      case "transfer_list":
        return queue(conflictMode);
      case "transfer_list_groups":
        return [];
      case "transfer_enqueue": {
        const items = Array.isArray(args.items) ? args.items : [];
        const log = ((window as unknown as Record<string, unknown>).__PREVIEW_OPS__ ??= []) as Array<
          Record<string, unknown>
        >;
        for (const it of items) {
          log.push({
            cmd: "transfer_enqueue",
            direction: it.direction,
            localPath: it.localPath,
            remotePath: it.remotePath,
          });
        }
        return items.map((_: unknown, i: number) => "t" + Date.now() + "_" + i);
      }
      case "sftp_list_dir": {
        const path = String(args.path ?? REMOTE_ROOT);
        const listingId = String(args.listingId ?? "");
        const channel = args.channel as { onmessage?: (msg: unknown) => void } | undefined;
        const page = listDir(path);
        setTimeout(() => {
          channel?.onmessage?.({
            k: "page",
            listingId,
            path,
            offset: 0,
            entries: page.entries,
          });
          channel?.onmessage?.({
            k: "done",
            listingId,
            path,
            total: page.entries.length,
          });
        }, 0);
        return null;
      }
      // 预览没有真实磁盘：本机新建/重命名/删除直接改夹具并记录调用
      case "local_mkdir": {
        const full = String(args.path ?? "");
        const name = full.split(/[\\/]/).pop() ?? full;
        localEntries.push({
          name,
          path: full,
          isDir: true,
          isSymlink: false,
          size: 0,
          mtime: Date.now(),
        });
        const log = ((window as unknown as Record<string, unknown>).__PREVIEW_OPS__ ??= []) as Array<
          Record<string, unknown>
        >;
        log.push({ cmd, ...args });
        return null;
      }
      case "local_rename": {
        const from = String(args.from ?? "");
        const to = String(args.to ?? "");
        const entry = localEntries.find((e) => e.path === from);
        if (entry) {
          entry.path = to;
          entry.name = to.split(/[\\/]/).pop() ?? entry.name;
        }
        const log = ((window as unknown as Record<string, unknown>).__PREVIEW_OPS__ ??= []) as Array<
          Record<string, unknown>
        >;
        log.push({ cmd, ...args });
        return null;
      }
      case "local_remove": {
        const idx = localEntries.findIndex((e) => e.path === String(args.path ?? ""));
        if (idx >= 0) localEntries.splice(idx, 1);
        const log = ((window as unknown as Record<string, unknown>).__PREVIEW_OPS__ ??= []) as Array<
          Record<string, unknown>
        >;
        log.push({ cmd, ...args });
        return null;
      }
      case "terminal_open":
        return { tabId: "preview-tab" };
      // 预览环境没有真实 SFTP：记录调用，供界面与自查断言使用
      case "sftp_mkdir":
      case "sftp_rename":
      case "sftp_remove": {
        const log = ((window as unknown as Record<string, unknown>).__PREVIEW_OPS__ ??= []) as Array<
          Record<string, unknown>
        >;
        log.push({ cmd, ...args });
        return null;
      }
      default:
        return null;
    }
  },
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
