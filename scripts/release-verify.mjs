// 发布产物自洽校验 + SHA256SUMS 生成。CI 与本地跑同一份逻辑，不依赖 GitHub。
//
// 用法：
//   node scripts/release-verify.mjs --dir artifacts                          # 只校验
//   node scripts/release-verify.mjs --dir artifacts --write-sums             # 先重写 SHA256SUMS.txt 再校验
//   node scripts/release-verify.mjs --dir artifacts --manifest docs/release/manifest-1.1.1.json
//   node scripts/release-verify.mjs --dir artifacts --expect-fail            # 自检：期望失败时退出码应为 1
//
// 校验四件事，任一不满足即退出码 1：
//   1. scripts/release-artifacts.mjs 里的 7 项期待产物各命中且仅命中 1 个文件（漏 rpm 会在这里报）；
//   2. SHA256SUMS.txt 行数 == 期待数，且每行路径/哈希与磁盘一致，无多余行；
//   3. manifest 里的产物条数 == 期待数，且文件名集合完全一致；
//   4. 没有 `*.sig` 混进上面两项（签名是附加文件，不计入期待数）。
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EXPECTED_ARTIFACTS, EXPECTED_COUNT } from "./release-artifacts.mjs";

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : fallback;
};
const dir = resolve(argOf("--dir", "artifacts"));
const manifestPath = argOf("--manifest", null);
const writeSums = argv.includes("--write-sums");
const artifactsOnly = argv.includes("--artifacts-only");

const sha256 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => ok(h.digest("hex")))
      .on("error", fail);
  });

function walk(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    const full = join(d, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!statSync(dir, { throwIfNoEntry: false })) {
  console.error(`[verify] 目录不存在：${dir}`);
  process.exit(1);
}

// 相对路径统一成 `./a/b/c` 的写法，与 sha256sum 输出、1.1.1 的清单保持一致。
const rel = (full) => `./${full.slice(dir.length + 1).replaceAll("\\", "/")}`;
const files = walk(dir).map((full) => ({ full, rel: rel(full), name: basename(full) }));
const errors = [];

// 1) 期待产物：每项恰好一个
const found = [];
for (const rule of EXPECTED_ARTIFACTS) {
  const hits = files.filter((f) => rule.match.test(f.name));
  if (hits.length === 0) {
    errors.push(`缺少产物：${rule.name}（期望 1 个，实际 0 个）`);
    continue;
  }
  if (hits.length > 1) {
    errors.push(`产物重复：${rule.name}（期望 1 个，实际 ${hits.length} 个：${hits.map((h) => h.rel).join(", ")}）`);
  }
  found.push({ rule, file: hits[0] });
}

// 4) 签名文件不能冒充产物
const sigs = files.filter((f) => f.name.endsWith(".sig"));
if (sigs.length && found.some((x) => x.file.name.endsWith(".sig"))) {
  errors.push("签名文件被当成产物计入，检查 release-artifacts.mjs 的正则");
}

// 2a) 需要时先重写 SHA256SUMS（只含 7 个安装包，签名与 latest.json 不计入）
if (writeSums && errors.length === 0) {
  const rows = [];
  for (const { file } of found) rows.push({ rel: file.rel, sha: await sha256(file.full) });
  rows.sort((a, b) => a.rel.localeCompare(b.rel));
  const body = rows.map((r) => `${r.sha}  ${r.rel}`).join("\n") + "\n";
  writeFileSync(join(dir, "SHA256SUMS.txt"), body);
  console.log(`[verify] 已重写 SHA256SUMS.txt（${rows.length} 行）`);
}

// 2b) SHA256SUMS 行数与内容
const sumsPath = join(dir, "SHA256SUMS.txt");
if (artifactsOnly) {
  // 只查齐全性时不做清单校验（此时 SHA256SUMS / manifest 还没生成）
} else if (!statSync(sumsPath, { throwIfNoEntry: false })) {
  errors.push("缺少 SHA256SUMS.txt");
} else {
  const lines = readFileSync(sumsPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length !== EXPECTED_COUNT) {
    errors.push(`SHA256SUMS.txt 行数 ${lines.length} != 期待 ${EXPECTED_COUNT}`);
  }
  const listed = new Map(lines.map((l) => [l.slice(66).trim(), l.slice(0, 64).trim()]));
  for (const { rule, file } of found) {
    if (!listed.has(file.rel)) {
      errors.push(`SHA256SUMS.txt 缺少 ${rule.name}：${file.rel}`);
      continue;
    }
    const actual = await sha256(file.full);
    if (listed.get(file.rel) !== actual) {
      errors.push(`SHA256与磁盘不符：${file.rel}`);
    }
  }
  for (const key of listed.keys()) {
    if (!found.some((x) => x.file.rel === key)) errors.push(`SHA256SUMS.txt 有多余行：${key}`);
  }
}

// 3) manifest 条数
if (manifestPath && !artifactsOnly) {
  const abs = resolve(manifestPath);
  if (!statSync(abs, { throwIfNoEntry: false })) {
    errors.push(`缺少 manifest：${abs}`);
  } else {
    const manifest = JSON.parse(readFileSync(abs, "utf8"));
    const list = (manifest.artifacts ?? []).filter((a) => !a.legacy);
    if (list.length !== EXPECTED_COUNT) {
      errors.push(`manifest 产物条数 ${list.length} != 期待 ${EXPECTED_COUNT}`);
    }
    const names = new Set(list.map((a) => a.name));
    for (const { rule, file } of found) {
      if (!names.has(file.name)) errors.push(`manifest 缺少 ${rule.name}：${file.name}`);
    }
    for (const n of names) {
      if (!found.some((x) => x.file.name === n)) errors.push(`manifest 多出产物：${n}`);
    }
  }
}

if (errors.length) {
  console.error(`[verify] FAIL（${errors.length} 项）`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`[verify] OK：${EXPECTED_COUNT} 项产物齐全，SHA256SUMS 与 manifest 条数一致`);
for (const { rule, file } of found) console.log(`  ${rule.id.padEnd(9)} ${file.rel}`);
