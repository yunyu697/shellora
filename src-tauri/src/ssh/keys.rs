//! 私钥加载：OpenSSH 新格式 / 传统 PEM（RSA、EC、PKCS#8）/ PuTTY PPK。
//!
//! OpenSSH 与 PEM 交给 `russh::keys::decode_secret_key`（含口令解密）；
//! PPK 由本模块解析后转换成 OpenSSH 私钥容器，再交给 `ssh-key` 校验。

use std::collections::HashMap;

use ssh_key::PrivateKey;

use crate::error::{ErrorCode, ErrorDto};

/// 读取并解析私钥文件。
pub fn load(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, ErrorDto> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        ErrorDto::new(ErrorCode::AuthFailed, format!("无法读取私钥 {path}：{e}"))
    })?;
    if is_ppk(&text) {
        return parse_ppk(&text);
    }
    russh::keys::decode_secret_key(&text, passphrase).map_err(|e| {
        let message = match e {
            russh::keys::Error::KeyIsEncrypted => {
                "私钥已加密：请提供口令（passphrase）".to_string()
            }
            other => format!("私钥解析失败：{other}"),
        };
        ErrorDto::new(ErrorCode::AuthFailed, message)
    })
}

fn is_ppk(text: &str) -> bool {
    text.lines()
        .next()
        .is_some_and(|line| line.trim_start().starts_with("PuTTY-User-Key-File-"))
}

fn auth_err(message: impl Into<String>) -> ErrorDto {
    ErrorDto::new(ErrorCode::AuthFailed, message)
}

/// PPK v2/v3（未加密）。加密 PPK 需要 v2 的 SHA-1 KDF 或 v3 的 Argon2，
/// 当前明确报错而不是静默失败。
fn parse_ppk(text: &str) -> Result<PrivateKey, ErrorDto> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let mut header: HashMap<String, String> = HashMap::new();
    let mut idx = 0usize;

    while idx < lines.len() {
        let line = lines[idx];
        let Some((key, value)) = line.split_once(':') else {
            break;
        };
        if key.trim() == "Public-Lines" {
            break;
        }
        header.insert(key.trim().to_string(), value.trim().to_string());
        idx += 1;
    }

    if header.is_empty() {
        return Err(auth_err("PPK 文件头缺失"));
    }
    if header.get("Encryption").map(String::as_str) != Some("none") {
        return Err(auth_err(
            "暂不支持加密的 PPK 私钥：请用 PuTTYgen 去掉口令，或导出为 OpenSSH 格式",
        ));
    }

    let public_blob = read_block(&lines, &mut idx, "Public-Lines")?;
    let private_blob = read_block(&lines, &mut idx, "Private-Lines")?;

    let mut cur = &public_blob[..];
    let algorithm = read_string(&mut cur).ok_or_else(|| auth_err("PPK 公钥缺少算法名"))?;

    let mut out = Vec::new();
    out.extend_from_slice(b"openssh-key-v1\0");
    put_string(&mut out, b"none"); // cipher
    put_string(&mut out, b"none"); // kdf
    put_string(&mut out, b""); // kdf options
    put_u32(&mut out, 1);
    put_string(&mut out, &public_blob);

    let mut priv_blob = Vec::new();
    let check = rand_core::RngCore::next_u32(&mut rand_core::OsRng);
    put_u32(&mut priv_blob, check);
    put_u32(&mut priv_blob, check);
    put_string(&mut priv_blob, &algorithm);

    let mut priv_cur = &private_blob[..];
    match algorithm.as_slice() {
        b"ssh-rsa" => {
            let e = read_mpint(&mut cur).ok_or_else(|| auth_err("PPK 公钥缺少 e"))?;
            let n = read_mpint(&mut cur).ok_or_else(|| auth_err("PPK 公钥缺少 n"))?;
            let d = read_mpint(&mut priv_cur).ok_or_else(|| auth_err("PPK 私钥缺少 d"))?;
            let p = read_mpint(&mut priv_cur).ok_or_else(|| auth_err("PPK 私钥缺少 p"))?;
            let q = read_mpint(&mut priv_cur).ok_or_else(|| auth_err("PPK 私钥缺少 q"))?;
            let iqmp = read_mpint(&mut priv_cur).ok_or_else(|| auth_err("PPK 私钥缺少 iqmp"))?;
            // OpenSSH 私钥的 RSA 字段顺序：n, e, d, iqmp, p, q。
            put_mpint(&mut priv_blob, &n);
            put_mpint(&mut priv_blob, &e);
            put_mpint(&mut priv_blob, &d);
            put_mpint(&mut priv_blob, &iqmp);
            put_mpint(&mut priv_blob, &p);
            put_mpint(&mut priv_blob, &q);
        }
        b"ssh-ed25519" => {
            let pub_key = read_string(&mut cur).ok_or_else(|| auth_err("PPK 公钥缺少公钥值"))?;
            let key = read_mpint(&mut priv_cur).ok_or_else(|| auth_err("PPK 私钥缺少密钥值"))?;
            if key.len() > 64 {
                return Err(auth_err(format!(
                    "Ed25519 PPK 私钥长度异常（{} 字节，应为 64）",
                    key.len()
                )));
            }
            // mpint 会吃掉前导 0，按 64 字节补回；PPK 里 ed25519 私钥是 seed+pub。
            let mut key64 = vec![0u8; 64 - key.len()];
            key64.extend_from_slice(&key);
            put_string(&mut priv_blob, &pub_key);
            put_string(&mut priv_blob, &key64);
        }
        b"ecdsa-sha2-nistp256" | b"ecdsa-sha2-nistp384" | b"ecdsa-sha2-nistp521" => {
            let curve = read_string(&mut cur).ok_or_else(|| auth_err("PPK 公钥缺少曲线名"))?;
            let point = read_string(&mut cur).ok_or_else(|| auth_err("PPK 公钥缺少曲线点"))?;
            let d = read_mpint(&mut priv_cur).ok_or_else(|| auth_err("PPK 私钥缺少 d"))?;
            put_string(&mut priv_blob, &curve);
            put_string(&mut priv_blob, &point);
            put_mpint(&mut priv_blob, &d);
        }
        other => {
            return Err(auth_err(format!(
                "PPK 算法不受支持：{}",
                String::from_utf8_lossy(other)
            )))
        }
    }

    let comment = header.get("Comment").map(String::as_str).unwrap_or("");
    put_string(&mut priv_blob, comment.as_bytes());
    // OpenSSH 私钥块填充：1,2,3… 直到 8 字节对齐。
    let mut pad = 1u8;
    while priv_blob.len() % 8 != 0 {
        priv_blob.push(pad);
        pad = pad.wrapping_add(1);
    }
    put_string(&mut out, &priv_blob);

    PrivateKey::from_bytes(&out)
        .map_err(|e| auth_err(format!("PPK 私钥校验失败：{e}")))
}

fn read_block(lines: &[&str], idx: &mut usize, name: &str) -> Result<Vec<u8>, ErrorDto> {
    let header = lines
        .get(*idx)
        .ok_or_else(|| auth_err(format!("PPK 缺少 {name} 段")))?;
    let count: usize = header
        .split_once(':')
        .and_then(|(k, v)| (k.trim() == name).then(|| v.trim().parse().ok()).flatten())
        .ok_or_else(|| auth_err(format!("PPK {name} 行格式错误")))?;
    *idx += 1;
    let mut payload = String::new();
    for _ in 0..count {
        let line = lines
            .get(*idx)
            .ok_or_else(|| auth_err(format!("PPK {name} 数据不完整")))?;
        payload.push_str(line.trim());
        *idx += 1;
    }
    data_encoding::BASE64
        .decode(payload.as_bytes())
        .map_err(|e| auth_err(format!("PPK {name} base64 解码失败：{e}")))
}

/// 读取 SSH wire 格式的 string（4 字节长度 + 内容）。
fn read_string(cur: &mut &[u8]) -> Option<Vec<u8>> {
    let len = read_u32(cur)? as usize;
    if cur.len() < len {
        return None;
    }
    let (head, tail) = cur.split_at(len);
    *cur = tail;
    Some(head.to_vec())
}

/// 读取 mpint 并去掉符号位带来的前导 0（保留值本身）。
fn read_mpint(cur: &mut &[u8]) -> Option<Vec<u8>> {
    let raw = read_string(cur)?;
    let start = raw.iter().position(|b| *b != 0).unwrap_or(raw.len());
    Some(raw[start..].to_vec())
}

fn read_u32(cur: &mut &[u8]) -> Option<u32> {
    if cur.len() < 4 {
        return None;
    }
    let (head, tail) = cur.split_at(4);
    *cur = tail;
    Some(u32::from_be_bytes([head[0], head[1], head[2], head[3]]))
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_string(out: &mut Vec<u8>, value: &[u8]) {
    put_u32(out, value.len() as u32);
    out.extend_from_slice(value);
}

/// mpint 编码：正数，最高位为 1 时补 0 避免被当作负数。
fn put_mpint(out: &mut Vec<u8>, value: &[u8]) {
    let start = value.iter().position(|b| *b != 0).unwrap_or(value.len());
    let value = &value[start..];
    let mut body = Vec::with_capacity(value.len() + 1);
    if value.first().is_some_and(|b| b & 0x80 != 0) {
        body.push(0);
    }
    body.extend_from_slice(value);
    put_string(out, &body);
}
