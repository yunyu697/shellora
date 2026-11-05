//! 输出合并器：把 russh 的小包合并成 ≤32KB、间隔 ≥8ms 的帧，减少 IPC 抖动。

use std::time::Instant;

use crate::config::{TERM_COALESCE_BYTES, TERM_COALESCE_MS};

pub struct Coalescer {
    buf: Vec<u8>,
    first_push: Option<Instant>,
}

impl Default for Coalescer {
    fn default() -> Self {
        Self::new()
    }
}

impl Coalescer {
    pub fn new() -> Self {
        Self { buf: Vec::with_capacity(TERM_COALESCE_BYTES), first_push: None }
    }

    /// 推入一段数据；满足阈值时返回可发送的一帧。
    pub fn push(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        if chunk.is_empty() {
            return None;
        }
        if self.first_push.is_none() {
            self.first_push = Some(Instant::now());
        }
        self.buf.extend_from_slice(chunk);
        if self.buf.len() >= TERM_COALESCE_BYTES || self.elapsed() >= TERM_COALESCE_MS {
            return self.take();
        }
        None
    }

    /// 定时器到期时调用，取走已缓存的数据。
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        if self.elapsed() >= TERM_COALESCE_MS {
            self.take()
        } else {
            None
        }
    }

    /// 强制取走（通道关闭前调用）。
    pub fn drain(&mut self) -> Option<Vec<u8>> {
        self.take()
    }

    /// 是否有待发送数据（用于决定读循环的等待粒度）。
    pub fn has_pending(&self) -> bool {
        !self.buf.is_empty()
    }

    fn elapsed(&self) -> u64 {
        self.first_push
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0)
    }

    fn take(&mut self) -> Option<Vec<u8>> {
        if self.buf.is_empty() {
            return None;
        }
        self.first_push = None;
        Some(std::mem::replace(&mut self.buf, Vec::with_capacity(TERM_COALESCE_BYTES)))
    }
}

/// 信用窗口：发送前 acquire，前端 ack 后 release，保证 JS 侧不被冲刷。
pub struct Window {
    permits: std::sync::Arc<tokio::sync::Semaphore>,
    permit_bytes: usize,
}

impl Window {
    pub fn new(total_bytes: usize, permit_bytes: usize) -> Self {
        Self {
            permits: std::sync::Arc::new(tokio::sync::Semaphore::new(total_bytes / permit_bytes)),
            permit_bytes,
        }
    }

    pub fn permits(&self) -> usize {
        (TERM_COALESCE_BYTES / self.permit_bytes).max(1)
    }

    pub fn semaphore(&self) -> std::sync::Arc<tokio::sync::Semaphore> {
        self.permits.clone()
    }
}

/// 把字节数换算为 permit 数（向上取整，至少 1）。
pub fn permits_for(bytes: usize, permit_bytes: usize) -> u32 {
    (bytes.div_ceil(permit_bytes).max(1)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_when_byte_threshold_reached() {
        let mut c = Coalescer::new();
        let chunk = vec![b'a'; 4096];
        let mut out = None;
        for _ in 0..8 {
            if let Some(v) = c.push(&chunk) {
                out = Some(v);
            }
        }
        let out = out.expect("should flush at 32KB");
        assert_eq!(out.len(), TERM_COALESCE_BYTES);
        assert!(c.drain().is_none());
    }

    #[test]
    fn drains_pending_on_close() {
        let mut c = Coalescer::new();
        assert!(c.push(b"hi").is_none());
        assert_eq!(c.drain().unwrap(), b"hi".to_vec());
        assert!(c.drain().is_none());
    }

    #[test]
    fn permits_are_ceiled() {
        assert_eq!(permits_for(1, 8192), 1);
        assert_eq!(permits_for(8192, 8192), 1);
        assert_eq!(permits_for(8193, 8192), 2);
    }

    #[test]
    fn empty_chunk_is_ignored() {
        let mut c = Coalescer::new();
        assert!(c.push(b"").is_none());
    }

    #[test]
    fn window_total_is_bounded() {
        let w = Window::new(crate::config::TERM_WINDOW_BYTES, 8192);
        assert_eq!(w.permits(), 4);
    }
}
