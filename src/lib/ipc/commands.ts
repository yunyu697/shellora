// IPC 命令封装：前端唯一的 Rust 交互出口（features 不直接 invoke）。

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ConnStateDto,
  ConnectionInput,
  ConnectionRow,
  DataClearReport,
  DataClearScope,
  DirListMsg,
  KnownHostRow,
  LocalDirPage,
  NewConnection,
  OpenTabDto,
  QueueMsg,
  SecretProbeDto,
  SessionRow,
  StreamMsg,
  TransferEnqueueItem,
  TransferGroup,
  TransferTask,
  TreeEnqueueRequest,
  TreeGroupStarted,
} from "./types";

export function openTerminal(
  input: ConnectionInput,
  onMessage: (msg: StreamMsg) => void,
): Promise<OpenTabDto> {
  const channel = new Channel<StreamMsg>();
  channel.onmessage = onMessage;
  return invoke<OpenTabDto>("terminal_open", { input, channel });
}

export function sendInput(tabId: string, data: string): Promise<void> {
  return invoke("terminal_input", { tabId, data });
}

/** 性能自测：只建立会话、不消费输出（用于“8 标签空闲”CPU 基准）。 */
export function openDetached(input: ConnectionInput): Promise<OpenTabDto> {
  const channel = new Channel<StreamMsg>();
  channel.onmessage = () => undefined;
  return invoke<OpenTabDto>("terminal_open", { input, channel });
}

export function resizeTerminal(tabId: string, cols: number, rows: number): Promise<void> {
  return invoke("terminal_resize", { tabId, cols, rows });
}

export function ackTerminal(tabId: string, bytes: number): Promise<void> {
  return invoke("terminal_ack", { tabId, bytes });
}

export function closeTerminal(tabId: string): Promise<void> {
  return invoke("terminal_close", { tabId });
}

export function retryTerminal(tabId: string): Promise<void> {
  return invoke("terminal_retry", { tabId });
}

export function terminalState(tabId: string): Promise<ConnStateDto> {
  return invoke<ConnStateDto>("terminal_state", { tabId });
}

export function probeSecret(): Promise<SecretProbeDto> {
  return invoke<SecretProbeDto>("secret_probe");
}

// ---- 会话库（M1）----

export function connTest(input: ConnectionInput): Promise<void> {
  return invoke("conn_test", { input });
}

// ---- 已知主机（M4.5）----

export function knownHostList(): Promise<KnownHostRow[]> {
  return invoke<KnownHostRow[]>("knownhost_list");
}

/** 手动删除信任记录；指纹变更后的唯一恢复路径。 */
export function knownHostDelete(id: string): Promise<number> {
  return invoke<number>("knownhost_delete", { id });
}

export function dbListConnections(): Promise<ConnectionRow[]> {
  return invoke<ConnectionRow[]>("db_list_connections");
}

export function dbInsertConnection(newConnection: NewConnection): Promise<string> {
  return invoke<string>("db_insert_connection", { new: newConnection });
}

export function dbDeleteConnection(id: string): Promise<number> {
  return invoke<number>("db_delete_connection", { id });
}

export function dbCreateSession(connectionId: string, name: string): Promise<string> {
  return invoke<string>("db_create_session", { connectionId, name });
}

export function dbListSessions(): Promise<SessionRow[]> {
  return invoke<SessionRow[]>("db_list_sessions");
}

// ---- SFTP 双栏与传输队列（M3）----

/** 远端目录流式分页；channel 需由调用方持有，防止被 GC。 */
export function listRemoteDir(
  tabId: string,
  path: string,
  listingId: string,
  onMessage: (msg: DirListMsg) => void,
): { channel: Channel<DirListMsg>; done: Promise<void> } {
  const channel = new Channel<DirListMsg>();
  channel.onmessage = onMessage;
  return { channel, done: invoke("sftp_list_dir", { tabId, path, listingId, channel }) };
}

export function cancelRemoteDir(listingId: string): Promise<void> {
  return invoke("sftp_cancel_list", { listingId });
}

/** 远端新建单层目录。 */
export function remoteMkdir(tabId: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { tabId, path });
}

/** 远端重命名 / 移动。 */
export function remoteRename(tabId: string, from: string, to: string): Promise<void> {
  return invoke("sftp_rename", { tabId, from, to });
}

/** 远端删除：目录需为空。 */
export function remoteRemove(tabId: string, path: string, isDir: boolean): Promise<void> {
  return invoke("sftp_remove", { tabId, path, isDir });
}

export function localHome(): Promise<string> {
  return invoke<string>("local_home");
}

export function listLocalDir(path: string, offset: number, limit = 500): Promise<LocalDirPage> {
  return invoke<LocalDirPage>("local_list_dir", { path, offset, limit });
}

/** 删除本机文件或空目录（符号链接只删链接本身）。 */
export function localRemove(path: string, isDir: boolean): Promise<void> {
  return invoke("local_remove", { path, isDir });
}

/** 新建单层本机目录。 */
export function localMkdir(path: string): Promise<void> {
  return invoke("local_mkdir", { path });
}

/** 本机重命名 / 移动；目标存在时后端会拒绝覆盖。 */
export function localRename(from: string, to: string): Promise<void> {
  return invoke("local_rename", { from, to });
}

/** 批量入队；channel 需由调用方持有，防止被 GC。 */
export function enqueueTransfers(
  items: TransferEnqueueItem[],
  onMessage: (msg: QueueMsg) => void,
): { channel: Channel<QueueMsg>; done: Promise<string[]> } {
  const channel = new Channel<QueueMsg>();
  channel.onmessage = onMessage;
  return { channel, done: invoke<string[]>("transfer_enqueue", { items, progress: channel }) };
}

export function transferPause(taskId: string): Promise<void> {
  return invoke("transfer_pause", { taskId });
}

export function transferResume(taskId: string): Promise<void> {
  return invoke("transfer_resume", { taskId });
}

export function transferCancel(taskId: string): Promise<void> {
  return invoke("transfer_cancel", { taskId });
}

export function transferResolve(
  taskId: string,
  choice: "overwrite" | "skip" | "rename",
  newName: string | null,
): Promise<void> {
  return invoke("transfer_resolve", { taskId, choice, newName });
}

export function transferList(): Promise<TransferTask[]> {
  return invoke<TransferTask[]>("transfer_list");
}

// ---- 递归目录传输（M3.5）----

/** 递归扫描并入队目录；channel 需由调用方持有，防止被 GC。 */
export function enqueueTree(
  request: TreeEnqueueRequest,
  onMessage: (msg: QueueMsg) => void,
): { channel: Channel<QueueMsg>; done: Promise<TreeGroupStarted> } {
  const channel = new Channel<QueueMsg>();
  channel.onmessage = onMessage;
  return {
    channel,
    done: invoke<TreeGroupStarted>("transfer_enqueue_tree", { request, progress: channel }),
  };
}

export function transferPauseGroup(groupId: string): Promise<void> {
  return invoke("transfer_pause_group", { groupId });
}

export function transferResumeGroup(groupId: string): Promise<void> {
  return invoke("transfer_resume_group", { groupId });
}

export function transferCancelGroup(groupId: string): Promise<void> {
  return invoke("transfer_cancel_group", { groupId });
}

export function transferResolveGroup(
  groupId: string,
  choice: "overwrite" | "skip" | "rename",
): Promise<void> {
  return invoke("transfer_resolve_group", { groupId, choice, newName: null });
}

export function transferListGroups(): Promise<TransferGroup[]> {
  return invoke<TransferGroup[]>("transfer_list_groups");
}

/** 清理本地数据；只动应用自有数据，不写系统 ~/.ssh。 */
export function clearData(scope: DataClearScope): Promise<DataClearReport> {
  return invoke<DataClearReport>("data_clear", { scope });
}
