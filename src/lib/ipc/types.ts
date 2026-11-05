// 与 src-tauri/src/ipc/dto.rs 一一对应（全 camelCase）。

export interface ConnectionInput {
  host: string;
  port: number;
  username: string;
  password: string;
  cols: number;
  rows: number;
  /** 私钥认证（OpenSSH / PEM / PPK）。 */
  privateKey?: PrivateKeyInput;
  /** ssh-agent 认证。 */
  agent?: AgentInput;
  /** SOCKS5 / HTTP CONNECT 代理。 */
  proxy?: ProxyInput;
  /** 跳板链，按顺序经过。 */
  jumps?: JumpInput[];
  /** 用户已确认首次连接：未知主机 TOFU 落库后放行。 */
  trustNewHostKeys?: boolean;
  /** 是否只读参考系统 ~/.ssh/known_hosts（默认 true）。 */
  useSystemKnownHosts?: boolean;
  /** 覆盖 known_hosts 路径（测试/自定义部署用）。 */
  knownHostsFile?: string | null;
}

export interface KnownHostFingerprint {
  keyType: string;
  fingerprintSha256: string;
}

/** `HOSTKEY_UNKNOWN` / `HOSTKEY_CHANGED` 的结构化细节。 */
export interface HostKeyDetails {
  kind: "unknown" | "changed";
  host: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  fingerprintMd5: string;
  /** 指纹变更时，已信任的旧指纹列表。 */
  known?: KnownHostFingerprint[];
}

/** 已信任主机记录（Rust `KnownHostRow`）。 */
export interface KnownHostRow {
  id: string;
  host: string;
  port: number;
  keyType: string;
  /** 公钥 blob 字节。 */
  publicKey: number[];
  fingerprintSha256: string;
  trust: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** 认证优先级：privateKey > agent > password。 */
export interface PrivateKeyInput {
  path: string;
  passphrase?: string | null;
}

export interface AgentInput {
  /** 为空则用平台默认（Unix：SSH_AUTH_SOCK；Windows：OpenSSH 管道 → Pageant）。 */
  socket?: string | null;
  /** SHA256 指纹或公钥 base64 片段；为空取第一个 identity。 */
  key?: string | null;
}

export type ProxyInput =
  | {
      kind: "socks5";
      host: string;
      port: number;
      username?: string | null;
      password?: string | null;
    }
  | {
      kind: "httpConnect";
      host: string;
      port: number;
      username?: string | null;
      password?: string | null;
    };

export interface JumpInput {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: PrivateKeyInput | null;
  agent?: AgentInput | null;
}

/** 每标签终端流消息，Rust 侧 serde tag = "k"。 */
export type StreamMsg =
  | { k: "data"; seq: number; b: number[] }
  | { k: "bell" }
  | { k: "title"; s: string }
  | { k: "eof"; code: number | null };

export type ConnState = "connecting" | "ready" | "suspended" | "closed" | "failed";

export interface ConnStateDto {
  state: ConnState;
  reason: string | null;
}

export interface ConnStateEvent {
  tabId: string;
  state: ConnState;
  reason: string | null;
}

export interface OpenTabDto {
  tabId: string;
}

export interface SecretProbeDto {
  backend: string;
  detail: string;
}

export interface ErrorDto {
  code: string;
  message: string;
  retriable: boolean;
  /** host key 拦截时携带指纹细节。 */
  details?: HostKeyDetails | null;
}

// ---- 会话库（M1）----

export interface ConnectionRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: string;
  credentialRefId: string | null;
  proxyMode: string;
  keepaliveMs: number;
  connectTimeoutMs: number;
  compression: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: string;
  credentialRefId: string | null;
}

export interface SessionRow {
  id: string;
  connectionId: string;
  name: string;
  groupId: string | null;
  terminalProfileId: string | null;
  colorTag: string | null;
  sortOrder: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---- SFTP 双栏（M3）----

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
}

/** 远端目录流式分页消息。 */
export type DirListMsg =
  | { k: "page"; listingId: string; path: string; offset: number; entries: DirEntry[] }
  | { k: "done"; listingId: string; path: string; total: number }
  | { k: "failed"; listingId: string; path: string; code: string; message: string };

export interface LocalDirPage {
  path: string;
  offset: number;
  entries: DirEntry[];
  hasMore: boolean;
  nextOffset: number;
}

export interface TransferEnqueueItem {
  direction: "upload" | "download";
  tabId: string;
  remotePath: string;
  localPath: string;
}

export type TransferState =
  | "queued"
  | "running"
  | "paused"
  | "conflict"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

export interface TransferTask {
  id: string;
  /** 递归入队时所属的组 id；单文件任务为 null。 */
  groupId: string | null;
  direction: "upload" | "download";
  tabId: string;
  remotePath: string;
  localPath: string;
  state: TransferState;
  transferred: number;
  total: number;
  mbps: number;
  etaSecs: number | null;
  resumedBytes: number;
  errorCode: string | null;
  message: string | null;
}

// ---- 递归目录传输（M3.5）----

export type ConflictPolicy = "ask" | "overwrite" | "skip" | "rename";

export type GroupState =
  | "queued"
  | "running"
  | "paused"
  | "conflict"
  | "done"
  | "failed"
  | "cancelled";

/** 递归入队后整组的聚合快照。 */
export interface TransferGroup {
  id: string;
  label: string;
  direction: "upload" | "download";
  remotePath: string;
  localPath: string;
  policy: ConflictPolicy;
  createEmptyDirs: boolean;
  state: GroupState;
  filesTotal: number;
  filesDone: number;
  transferred: number;
  total: number;
  mbps: number;
  etaSecs: number | null;
  errorCode: string | null;
}

export type QueueMsg =
  | { k: "update"; task: TransferTask }
  | { k: "group"; group: TransferGroup };

export interface TreeOptions {
  maxDepth: number;
  maxFiles: number;
  createEmptyDirs: boolean;
  conflictPolicy: ConflictPolicy;
}

export interface TreeEnqueueRequest {
  direction: "upload" | "download";
  tabId: string;
  sourcePath: string;
  destDir: string;
  options: TreeOptions;
}

export interface TreeGroupStarted {
  groupId: string;
  files: number;
  dirsCreated: number;
  bytes: number;
}

/** 数据清理范围：cache = 仅缓存；all = 全清。 */
export type DataClearScope = "cache" | "all";

export interface DataClearReport {
  scope: DataClearScope;
  rowsRemoved: number;
  items: string[];
  dbPath: string;
  warnings: string[];
}
