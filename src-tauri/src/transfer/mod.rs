//! 传输队列管理器（M3 / M3.5）。
//!
//! - 默认 `TRANSFER_CONCURRENCY = 2` 个任务并发，任务内部仍沿用 M2 的 4 通道引擎。
//! - 暂停/取消通过原子标记传给 worker，在块边界退出并保留 `.part` 与续传偏移。
//! - 目标已存在时按冲突策略处理：整组统一覆盖/跳过/重命名，或逐项询问。
//! - 递归目录入队时先扫描整棵树，再为每个文件建任务；同一组的任务共享聚合进度。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use tauri::ipc::Channel;
use tokio::sync::Semaphore;

use crate::config::TRANSFER_CONCURRENCY;
use crate::db::Database;
use crate::error::ErrorDto;
use crate::ipc::dto::{
    QueueMsg, TransferGroupDto, TransferMsg, TransferTaskDto, TreeEnqueueRequest,
    TreeGroupStartedDto,
};
use crate::sftp::{self, SharedSsh, TransferControl, TransferRequest};

const TARGET_EXISTS: &str = "SFTP_TARGET_EXISTS";

#[derive(Debug, Clone)]
pub struct EnqueueItem {
    pub direction: String,
    pub tab_id: String,
    pub remote_path: String,
    pub local_path: String,
}

#[derive(Debug, Clone)]
pub enum ConflictChoice {
    Overwrite,
    Skip,
    Rename { new_name: Option<String> },
}

impl ConflictChoice {
    fn policy(&self) -> Policy {
        match self {
            Self::Overwrite => Policy::Overwrite,
            Self::Skip => Policy::Skip,
            Self::Rename { .. } => Policy::Rename,
        }
    }
}

/// 组内冲突处理策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Policy {
    Ask,
    Overwrite,
    Skip,
    Rename,
}

impl Policy {
    fn from_str(raw: &str) -> Option<Self> {
        match raw {
            "ask" => Some(Self::Ask),
            "overwrite" => Some(Self::Overwrite),
            "skip" => Some(Self::Skip),
            "rename" => Some(Self::Rename),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Overwrite => "overwrite",
            Self::Skip => "skip",
            Self::Rename => "rename",
        }
    }
}

struct TaskInner {
    direction: String,
    tab_id: String,
    remote_path: String,
    local_path: String,
    overwrite: bool,
    policy: Policy,
    dto: TransferTaskDto,
}

struct Task {
    ssh: SharedSsh,
    db: Database,
    channel: Option<Channel<QueueMsg>>,
    pause: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    /// 保证同一任务最多一个 runner 在跑（resume 时排队等待旧 runner 退出）。
    run_lock: tokio::sync::Mutex<()>,
    /// 所属组（弱引用，组持有任务的强引用，避免循环）。
    group: Option<Weak<Group>>,
    inner: StdMutex<TaskInner>,
}

impl Task {
    fn state(&self) -> &'static str {
        self.inner
            .lock()
            .map(|i| i.dto.state)
            .unwrap_or("queued")
    }

    fn id(&self) -> String {
        self.inner
            .lock()
            .map(|i| i.dto.id.clone())
            .unwrap_or_default()
    }

    fn snapshot(&self) -> TransferTaskDto {
        self.inner
            .lock()
            .map(|i| i.dto.clone())
            .unwrap_or_else(|_| unreachable!("task mutex poisoned"))
    }

    fn send(&self, dto: TransferTaskDto) {
        if let Some(ch) = &self.channel {
            if let Err(err) = ch.send(QueueMsg::Update { task: dto }) {
                tracing::warn!(target: "transfer", %err, "queue channel closed");
            }
        }
    }

    /// 更新 DTO 并推送给前端；若属于某个组，再让组重算聚合进度。
    fn update<F>(&self, f: F)
    where
        F: FnOnce(&mut TransferTaskDto),
    {
        let dto = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            f(&mut inner.dto);
            inner.dto.clone()
        };
        self.send(dto);
        self.notify_group();
    }

    fn notify_group(&self) {
        if let Some(weak) = &self.group {
            if let Some(group) = weak.upgrade() {
                group.recompute();
            }
        }
    }

    fn transition(&self, state: &'static str, error: Option<(&str, String)>) {
        self.update(|dto| {
            dto.state = state;
            match error {
                Some((code, message)) => {
                    dto.error_code = Some(code.to_string());
                    dto.message = Some(message);
                }
                None => {
                    dto.error_code = None;
                    dto.message = None;
                }
            }
            if state == "done" || state == "cancelled" || state == "skipped" {
                dto.eta_secs = None;
            }
        });
    }

    fn patch_progress(&self, transferred: u64, total: u64, mbps: f64) {
        self.update(|dto| {
            dto.transferred = transferred;
            dto.total = total;
            dto.mbps = mbps;
            dto.eta_secs = if mbps > 0.0 && total > transferred {
                Some((total - transferred) as f64 / (mbps * 1024.0 * 1024.0))
            } else {
                None
            };
        });
    }

    fn set_overwrite(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.overwrite = true;
        }
    }

    fn set_policy(&self, policy: Policy) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.policy = policy;
        }
    }

    /// 把任务改指向新的目标名（远端或本地）。
    fn retarget(&self, candidate: String) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.overwrite = false;
            if inner.direction == "upload" {
                inner.remote_path = candidate.clone();
                inner.dto.remote_path = candidate;
            } else {
                inner.local_path = candidate.clone();
                inner.dto.local_path = candidate;
            }
        }
    }

    /// 执行引擎；整组冲突策略在冲突时自动重试。
    async fn run(self: Arc<Self>) {
        loop {
            let (spec, control, policy) = {
                let Ok(inner) = self.inner.lock() else {
                    return;
                };
                (
                    (
                        inner.direction.clone(),
                        inner.tab_id.clone(),
                        inner.remote_path.clone(),
                        inner.local_path.clone(),
                        inner.overwrite,
                    ),
                    TransferControl {
                        pause: self.pause.clone(),
                        cancel: self.cancel.clone(),
                    },
                    inner.policy,
                )
            };
            let (direction, tab_id, remote_path, local_path, overwrite) = spec;

            self.update(|dto| {
                dto.state = "running";
                dto.error_code = None;
                dto.message = None;
            });

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<TransferMsg>();
            let forwarder = {
                let this = self.clone();
                tokio::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        if let TransferMsg::Progress {
                            transferred,
                            total,
                            mbps,
                            ..
                        } = msg
                        {
                            this.patch_progress(transferred, total, mbps);
                        }
                    }
                })
            };

            let req = TransferRequest {
                tab_id: Some(tab_id),
                remote_path: remote_path.clone(),
                local_path: std::path::PathBuf::from(&local_path),
                progress: None,
                progress_tx: Some(tx),
                control,
                overwrite,
                interrupt_at: None,
            };
            let result = if direction == "upload" {
                sftp::upload(self.ssh.clone(), &self.db, req).await
            } else {
                sftp::download(self.ssh.clone(), &self.db, req).await
            };
            let _ = forwarder.await;

            match result {
                Ok(res) => {
                    self.update(|dto| {
                        dto.state = "done";
                        dto.transferred = res.total;
                        dto.total = res.total;
                        dto.mbps = res.mbps;
                        dto.resumed_bytes = res.resumed_bytes;
                        dto.eta_secs = None;
                        dto.error_code = None;
                        dto.message = None;
                    });
                    return;
                }
                Err(err) => {
                    if self.cancel.load(Ordering::Relaxed) {
                        self.transition("cancelled", None);
                        return;
                    }
                    if self.pause.load(Ordering::Relaxed) {
                        self.transition("paused", None);
                        return;
                    }
                    if err.code == TARGET_EXISTS {
                        match policy {
                            Policy::Overwrite => {
                                self.set_overwrite();
                                continue;
                            }
                            Policy::Skip => {
                                self.transition("skipped", None);
                                return;
                            }
                            Policy::Rename => {
                                let picked = if direction == "upload" {
                                    pick_remote_name(&self.ssh, &remote_path, None).await
                                } else {
                                    pick_local_name(&local_path, None).await
                                };
                                match picked {
                                    Ok(candidate) => {
                                        self.retarget(candidate);
                                        continue;
                                    }
                                    Err(err) => {
                                        self.transition(
                                            "failed",
                                            Some((err.code, err.message)),
                                        );
                                        return;
                                    }
                                }
                            }
                            Policy::Ask => {
                                self.transition("conflict", Some((err.code, err.message)));
                                return;
                            }
                        }
                    }
                    self.transition("failed", Some((err.code, err.message)));
                    return;
                }
            }
        }
    }
}

struct GroupInner {
    dto: TransferGroupDto,
    paused: bool,
}

/// 一次递归入队对应的组：子任务共享聚合进度与整组控制。
pub struct Group {
    channel: Option<Channel<QueueMsg>>,
    tasks: StdMutex<Vec<Arc<Task>>>,
    inner: StdMutex<GroupInner>,
}

impl Group {
    fn send(&self, dto: TransferGroupDto) {
        if let Some(ch) = &self.channel {
            if let Err(err) = ch.send(QueueMsg::Group { group: dto }) {
                tracing::warn!(target: "transfer", %err, "queue channel closed");
            }
        }
    }

    fn task_list(&self) -> Vec<Arc<Task>> {
        self.tasks.lock().map(|t| t.clone()).unwrap_or_default()
    }

    fn set_paused(&self, paused: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.paused = paused;
        }
    }

    fn set_policy(&self, policy: Policy) {
        let tasks = self.task_list();
        for task in &tasks {
            task.set_policy(policy);
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.dto.policy = policy.as_str().to_string();
        }
    }

    /// 用子任务快照重算组聚合进度（已传/总量/速率/剩余时间/状态）。
    fn recompute(&self) {
        let tasks = self.task_list();
        let snaps: Vec<TransferTaskDto> = tasks.iter().map(|t| t.snapshot()).collect();
        let (paused, mut dto) = match self.inner.lock() {
            Ok(inner) => (inner.paused, inner.dto.clone()),
            Err(_) => return,
        };

        let mut files_done = 0usize;
        let mut transferred = 0u64;
        let mut total = 0u64;
        let mut mbps = 0.0f64;
        let mut any_running = false;
        let mut any_conflict = false;
        let mut any_failed = false;
        let mut any_cancelled = false;
        let mut error_code = None;
        for snap in &snaps {
            transferred += snap.transferred;
            total += snap.total;
            mbps += snap.mbps;
            match snap.state {
                "done" | "skipped" => files_done += 1,
                "running" => any_running = true,
                "conflict" => any_conflict = true,
                "failed" => {
                    any_failed = true;
                    if error_code.is_none() {
                        error_code = snap.error_code.clone();
                    }
                }
                "cancelled" => any_cancelled = true,
                _ => {}
            }
        }
        let all_terminal = snaps
            .iter()
            .all(|s| matches!(s.state, "done" | "skipped" | "failed" | "cancelled"));
        let state = if all_terminal {
            if any_failed {
                "failed"
            } else if any_cancelled {
                "cancelled"
            } else {
                "done"
            }
        } else if any_running {
            "running"
        } else if paused {
            "paused"
        } else if any_conflict {
            "conflict"
        } else {
            "queued"
        };

        dto.state = state;
        dto.files_total = snaps.len();
        dto.files_done = files_done;
        dto.transferred = transferred;
        dto.total = total;
        dto.mbps = mbps;
        dto.eta_secs = if mbps > 0.0 && total > transferred {
            Some((total - transferred) as f64 / (mbps * 1024.0 * 1024.0))
        } else {
            None
        };
        dto.error_code = error_code;

        if let Ok(mut inner) = self.inner.lock() {
            inner.dto = dto.clone();
        }
        self.send(dto);
    }
}

pub struct TransferManager {
    tasks: StdMutex<HashMap<String, Arc<Task>>>,
    order: StdMutex<Vec<String>>,
    groups: StdMutex<HashMap<String, Arc<Group>>>,
    group_order: StdMutex<Vec<String>>,
    permits: Arc<Semaphore>,
}

impl Default for TransferManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TransferManager {
    pub fn new() -> Self {
        Self {
            tasks: StdMutex::new(HashMap::new()),
            order: StdMutex::new(Vec::new()),
            groups: StdMutex::new(HashMap::new()),
            group_order: StdMutex::new(Vec::new()),
            permits: Arc::new(Semaphore::new(TRANSFER_CONCURRENCY)),
        }
    }

    /// 批量入队（单文件）；返回任务 id（与入参顺序一致）。
    pub async fn enqueue(
        self: &Arc<Self>,
        db: &Database,
        ssh: SharedSsh,
        items: Vec<EnqueueItem>,
        channel: Option<Channel<QueueMsg>>,
    ) -> Result<Vec<String>, ErrorDto> {
        let mut ids = Vec::with_capacity(items.len());
        for item in items {
            if item.direction != "upload" && item.direction != "download" {
                return Err(ErrorDto::internal(format!(
                    "未知传输方向：{}",
                    item.direction
                )));
            }
            let id = uuid::Uuid::now_v7().to_string();
            let dto = TransferTaskDto {
                id: id.clone(),
                group_id: None,
                direction: item.direction.clone(),
                tab_id: item.tab_id.clone(),
                remote_path: item.remote_path.clone(),
                local_path: item.local_path.clone(),
                state: "queued",
                transferred: 0,
                total: 0,
                mbps: 0.0,
                eta_secs: None,
                resumed_bytes: 0,
                error_code: None,
                message: None,
            };
            let task = Arc::new(Task {
                ssh: ssh.clone(),
                db: db.clone(),
                channel: channel.clone(),
                pause: Arc::new(AtomicBool::new(false)),
                cancel: Arc::new(AtomicBool::new(false)),
                run_lock: tokio::sync::Mutex::new(()),
                group: None,
                inner: StdMutex::new(TaskInner {
                    direction: item.direction,
                    tab_id: item.tab_id,
                    remote_path: item.remote_path,
                    local_path: item.local_path,
                    overwrite: false,
                    policy: Policy::Ask,
                    dto,
                }),
            });
            self.register_task(&task);
            task.send(task.snapshot());
            ids.push(id.clone());
            self.spawn_run(task);
        }
        Ok(ids)
    }

    /// 递归目录入队：先扫描（受最大深度/文件数限制），再按文件建组任务。
    pub async fn enqueue_tree(
        self: &Arc<Self>,
        db: &Database,
        ssh: SharedSsh,
        request: TreeEnqueueRequest,
        channel: Option<Channel<QueueMsg>>,
    ) -> Result<TreeGroupStartedDto, ErrorDto> {
        let direction = request.direction.as_str();
        if direction != "upload" && direction != "download" {
            return Err(ErrorDto::internal(format!(
                "未知传输方向：{}",
                request.direction
            )));
        }
        let policy = Policy::from_str(&request.options.conflict_policy).ok_or_else(|| {
            ErrorDto::internal(format!(
                "未知冲突策略：{}",
                request.options.conflict_policy
            ))
        })?;
        let max_depth = request.options.max_depth.max(1);
        let max_files = request.options.max_files.max(1);

        // 1) 扫描整棵树（超限直接报错，不卡死）。
        let (files, dirs) = if direction == "upload" {
            let tree = crate::local::walk_tree(
                Path::new(&request.source_path),
                max_depth,
                max_files,
            )
            .await?;
            let mut files = Vec::with_capacity(tree.files.len());
            for f in &tree.files {
                files.push((f.relative.clone(), f.size));
            }
            (files, tree.dirs)
        } else {
            let tree = sftp::dir::walk_tree(
                ssh.clone(),
                request.source_path.clone(),
                max_depth,
                max_files,
            )
            .await?;
            let mut files = Vec::with_capacity(tree.files.len());
            for f in &tree.files {
                files.push((f.relative.clone(), f.size));
            }
            (files, tree.dirs)
        };
        let total_bytes: u64 = files.iter().map(|(_, size)| *size).sum();

        // 2) 计算两端根路径。
        let root_name = root_name(&request.source_path, direction);
        let local_root = if direction == "upload" {
            PathBuf::from(&request.source_path)
        } else {
            PathBuf::from(&request.dest_dir).join(&root_name)
        };
        let remote_root = if direction == "upload" {
            sftp::dir::join_remote(&request.dest_dir, &root_name)
        } else {
            request.source_path.clone()
        };

        // 3) 先建目录：父目录一定排在子目录之前。
        let wanted = wanted_dirs(&files, &dirs, request.options.create_empty_dirs);
        let mut dirs_created = 0usize;
        if !files.is_empty() || request.options.create_empty_dirs {
            if direction == "upload" {
                let mut paths = vec![remote_root.clone()];
                for rel in &wanted {
                    paths.push(sftp::dir::join_remote(&remote_root, rel));
                }
                dirs_created = sftp::dir::create_dirs(ssh.clone(), paths).await?;
            } else {
                let mut paths = vec![local_root.clone()];
                for rel in &wanted {
                    paths.push(local_root.join(rel));
                }
                dirs_created = crate::local::create_dirs(&paths).await?;
            }
        }

        // 4) 建组与子任务。
        let group_id = uuid::Uuid::now_v7().to_string();
        let group = Arc::new(Group {
            channel: channel.clone(),
            tasks: StdMutex::new(Vec::new()),
            inner: StdMutex::new(GroupInner {
                dto: TransferGroupDto {
                    id: group_id.clone(),
                    label: root_name.clone(),
                    direction: direction.to_string(),
                    remote_path: remote_root.clone(),
                    local_path: local_root.to_string_lossy().to_string(),
                    policy: policy.as_str().to_string(),
                    create_empty_dirs: request.options.create_empty_dirs,
                    state: "queued",
                    files_total: files.len(),
                    files_done: 0,
                    transferred: 0,
                    total: total_bytes,
                    mbps: 0.0,
                    eta_secs: None,
                    error_code: None,
                },
                paused: false,
            }),
        });
        if let Ok(mut map) = self.groups.lock() {
            map.insert(group_id.clone(), group.clone());
        }
        if let Ok(mut order) = self.group_order.lock() {
            order.push(group_id.clone());
        }

        let mut spawned = Vec::with_capacity(files.len());
        for (relative, size) in &files {
            let id = uuid::Uuid::now_v7().to_string();
            let remote_path = sftp::dir::join_remote(&remote_root, relative);
            let local_path = local_root.join(relative).to_string_lossy().to_string();
            let dto = TransferTaskDto {
                id: id.clone(),
                group_id: Some(group_id.clone()),
                direction: direction.to_string(),
                tab_id: request.tab_id.clone(),
                remote_path,
                local_path,
                state: "queued",
                transferred: 0,
                total: *size,
                mbps: 0.0,
                eta_secs: None,
                resumed_bytes: 0,
                error_code: None,
                message: None,
            };
            let (remote_path, local_path) = (dto.remote_path.clone(), dto.local_path.clone());
            let task = Arc::new(Task {
                ssh: ssh.clone(),
                db: db.clone(),
                channel: channel.clone(),
                pause: Arc::new(AtomicBool::new(false)),
                cancel: Arc::new(AtomicBool::new(false)),
                run_lock: tokio::sync::Mutex::new(()),
                group: Some(Arc::downgrade(&group)),
                inner: StdMutex::new(TaskInner {
                    direction: direction.to_string(),
                    tab_id: request.tab_id.clone(),
                    remote_path,
                    local_path,
                    overwrite: policy == Policy::Overwrite,
                    policy,
                    dto,
                }),
            });
            self.register_task(&task);
            if let Ok(mut tasks) = group.tasks.lock() {
                tasks.push(task.clone());
            }
            task.send(task.snapshot());
            spawned.push(task);
        }

        group.recompute();
        for task in spawned {
            self.spawn_run(task);
        }

        Ok(TreeGroupStartedDto {
            group_id,
            files: files.len(),
            dirs_created,
            bytes: total_bytes,
        })
    }

    fn register_task(&self, task: &Arc<Task>) {
        let id = task.id();
        if let Ok(mut map) = self.tasks.lock() {
            map.insert(id.clone(), task.clone());
        }
        if let Ok(mut order) = self.order.lock() {
            order.push(id);
        }
    }

    fn spawn_run(self: &Arc<Self>, task: Arc<Task>) {
        let manager = self.clone();
        tokio::spawn(async move {
            let permit = manager.permits.clone().acquire_owned().await;
            let Ok(_permit) = permit else {
                return;
            };
            let _guard = task.run_lock.lock().await;
            if task.cancel.load(Ordering::Relaxed) {
                task.transition("cancelled", None);
                return;
            }
            if task.pause.load(Ordering::Relaxed) {
                task.transition("paused", None);
                return;
            }
            task.clone().run().await;
        });
    }

    fn task(&self, id: &str) -> Result<Arc<Task>, ErrorDto> {
        self.tasks
            .lock()
            .ok()
            .and_then(|map| map.get(id).cloned())
            .ok_or_else(|| ErrorDto::internal(format!("传输任务不存在：{id}")))
    }

    fn group(&self, id: &str) -> Result<Arc<Group>, ErrorDto> {
        self.groups
            .lock()
            .ok()
            .and_then(|map| map.get(id).cloned())
            .ok_or_else(|| ErrorDto::internal(format!("传输组不存在：{id}")))
    }

    pub fn list(&self) -> Vec<TransferTaskDto> {
        let Ok(order) = self.order.lock() else {
            return Vec::new();
        };
        let Ok(tasks) = self.tasks.lock() else {
            return Vec::new();
        };
        order
            .iter()
            .filter_map(|id| tasks.get(id).map(|t| t.snapshot()))
            .collect()
    }

    pub fn list_groups(&self) -> Vec<TransferGroupDto> {
        let Ok(order) = self.group_order.lock() else {
            return Vec::new();
        };
        let Ok(groups) = self.groups.lock() else {
            return Vec::new();
        };
        order
            .iter()
            .filter_map(|id| {
                groups
                    .get(id)
                    .and_then(|g| g.inner.lock().ok().map(|i| i.dto.clone()))
            })
            .collect()
    }

    pub fn pause(&self, id: &str) -> Result<(), ErrorDto> {
        let task = self.task(id)?;
        task.pause.store(true, Ordering::Relaxed);
        if task.state() == "queued" {
            task.transition("paused", None);
        }
        Ok(())
    }

    pub fn resume(self: &Arc<Self>, id: &str) -> Result<(), ErrorDto> {
        let task = self.task(id)?;
        let state = task.state();
        if state != "paused" && state != "queued" {
            return Err(ErrorDto::internal(format!("任务当前不可继续：{state}")));
        }
        task.pause.store(false, Ordering::Relaxed);
        task.cancel.store(false, Ordering::Relaxed);
        task.transition("queued", None);
        self.spawn_run(task);
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<(), ErrorDto> {
        let task = self.task(id)?;
        task.cancel.store(true, Ordering::Relaxed);
        if matches!(task.state(), "queued" | "paused" | "conflict") {
            task.transition("cancelled", None);
        }
        Ok(())
    }

    /// 处理单任务 `conflict`：覆盖 / 跳过 / 重命名（可带用户输入的新文件名）。
    pub async fn resolve(
        self: &Arc<Self>,
        id: &str,
        choice: ConflictChoice,
    ) -> Result<(), ErrorDto> {
        let task = self.task(id)?;
        if task.state() != "conflict" {
            return Err(ErrorDto::internal("任务不在冲突状态"));
        }
        let (direction, remote_path, local_path) = {
            let Ok(inner) = task.inner.lock() else {
                return Err(ErrorDto::internal("任务状态锁失效"));
            };
            (
                inner.direction.clone(),
                inner.remote_path.clone(),
                inner.local_path.clone(),
            )
        };

        match &choice {
            ConflictChoice::Skip => {
                task.set_policy(Policy::Skip);
                task.transition("skipped", None);
                return Ok(());
            }
            ConflictChoice::Overwrite => {
                task.set_policy(Policy::Overwrite);
                task.set_overwrite();
            }
            ConflictChoice::Rename { new_name } => {
                task.set_policy(Policy::Rename);
                let is_upload = direction == "upload";
                let candidate = if is_upload {
                    pick_remote_name(&task.ssh, &remote_path, new_name.clone()).await?
                } else {
                    pick_local_name(&local_path, new_name.clone()).await?
                };
                task.retarget(candidate);
            }
        }

        task.transition("queued", None);
        self.spawn_run(task);
        Ok(())
    }

    /// 整组统一冲突策略：更新组策略并立即处理所有冲突中的子任务。
    pub async fn resolve_group(
        self: &Arc<Self>,
        id: &str,
        choice: ConflictChoice,
    ) -> Result<(), ErrorDto> {
        let group = self.group(id)?;
        group.set_policy(choice.policy());
        let conflicted: Vec<String> = group
            .task_list()
            .into_iter()
            .filter(|t| t.state() == "conflict")
            .map(|t| t.id())
            .collect();
        for task_id in conflicted {
            self.resolve(&task_id, choice.clone()).await?;
        }
        group.recompute();
        Ok(())
    }

    pub fn pause_group(&self, id: &str) -> Result<(), ErrorDto> {
        let group = self.group(id)?;
        group.set_paused(true);
        for task in group.task_list() {
            task.pause.store(true, Ordering::Relaxed);
            if task.state() == "queued" {
                task.transition("paused", None);
            }
        }
        group.recompute();
        Ok(())
    }

    pub fn resume_group(self: &Arc<Self>, id: &str) -> Result<(), ErrorDto> {
        let group = self.group(id)?;
        group.set_paused(false);
        for task in group.task_list() {
            let state = task.state();
            if state == "paused" || state == "queued" {
                task.pause.store(false, Ordering::Relaxed);
                task.cancel.store(false, Ordering::Relaxed);
                task.transition("queued", None);
                self.spawn_run(task);
            }
        }
        group.recompute();
        Ok(())
    }

    pub fn cancel_group(&self, id: &str) -> Result<(), ErrorDto> {
        let group = self.group(id)?;
        for task in group.task_list() {
            task.cancel.store(true, Ordering::Relaxed);
            if matches!(task.state(), "queued" | "paused" | "conflict") {
                task.transition("cancelled", None);
            }
        }
        group.recompute();
        Ok(())
    }
}

/// 扫描根目录名：上传取本地路径末段，下载取远端路径末段。
fn root_name(path: &str, direction: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let name = if direction == "upload" {
        Path::new(trimmed)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
    } else {
        trimmed.rsplit('/').next().map(|n| n.to_string())
    };
    name.filter(|n| !n.is_empty()).unwrap_or_else(|| {
        if direction == "upload" {
            "upload".to_string()
        } else {
            "download".to_string()
        }
    })
}

/// 需要创建的相对目录：只建文件所需目录，或按开关连空目录一起建。
fn wanted_dirs(
    files: &[(String, u64)],
    scanned: &[String],
    create_empty_dirs: bool,
) -> Vec<String> {
    if create_empty_dirs {
        let mut all: Vec<String> = scanned.to_vec();
        all.sort_by(|a, b| {
            a.matches('/')
                .count()
                .cmp(&b.matches('/').count())
                .then_with(|| a.cmp(b))
        });
        return all;
    }

    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (relative, _) in files {
        let parts: Vec<&str> = relative.split('/').collect();
        for i in 1..parts.len() {
            set.insert(parts[..i].join("/"));
        }
    }
    set.into_iter().collect()
}

/// 在远端挑一个不冲突的名字；用户给定名字优先，存在则自动追加 ` (n)`。
async fn pick_remote_name(
    ssh: &SharedSsh,
    current: &str,
    new_name: Option<String>,
) -> Result<String, ErrorDto> {
    let (dir, original) = remote_dir_name(current);
    let base = sanitize_name(new_name.as_deref(), &original);
    for i in 0..1000usize {
        let candidate = if i == 0 && new_name.is_some() {
            format!("{dir}{base}")
        } else {
            format!("{dir}{}", suffixed(&base, i.max(1)))
        };
        if !sftp::remote_exists(ssh.clone(), candidate.clone()).await? {
            return Ok(candidate);
        }
    }
    Err(ErrorDto::internal("无法生成不冲突的远端文件名"))
}

async fn pick_local_name(
    current: &str,
    new_name: Option<String>,
) -> Result<String, ErrorDto> {
    let path = std::path::Path::new(current);
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let original = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let base = sanitize_name(new_name.as_deref(), &original);
    for i in 0..1000usize {
        let name = if i == 0 && new_name.is_some() {
            base.clone()
        } else {
            suffixed(&base, i.max(1))
        };
        let candidate = dir.join(&name);
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err(ErrorDto::internal("无法生成不冲突的本地文件名"))
}

fn remote_dir_name(path: &str) -> (String, String) {
    match path.rfind('/') {
        Some(idx) => (path[..=idx].to_string(), path[idx + 1..].to_string()),
        None => (String::new(), path.to_string()),
    }
}

fn sanitize_name(input: Option<&str>, fallback: &str) -> String {
    input
        .and_then(|raw| std::path::Path::new(raw).file_name())
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// `foo.bin` + 1 → `foo (1).bin`；无扩展名 → `foo (1)`。
fn suffixed(name: &str, n: usize) -> String {
    match name.rfind('.') {
        Some(idx) if idx > 0 => format!("{} ({n}){}", &name[..idx], &name[idx..]),
        _ => format!("{name} ({n})"),
    }
}
