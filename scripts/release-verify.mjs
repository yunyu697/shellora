// 发布产物自洽校验 + SHA256SUMS 生成。CI 与本地跑同一份逻辑，不依赖 GitHub。
//
// 用法：
//   node scripts/release-verify.mjs --dir artifacts                          # 只校验
//   node scripts/release-verify.mjs --dir artifacts --write-sums             # 先重写 SHA256SUMS.txt 再校验
//   node scripts/release-verify.mjs --dir artifacts --manifest docs/release/manifest-1.1.1.json
//   node scripts/release-verify.mjs --dir artifacts --exact --manifest docs/release/manifest-1.1.2.json
//   node scripts/release-verify.mjs --dir artifacts --expect-fail            # 自检：期望失败时退出码应为 1
//
// 校验五件事，任一不满足即退出码 1：
//   1. scripts/release-artifacts.mjs 里的 7 项期待产物各命中且仅命中 1 个文件（漏 rpm 会在这里报）；
//   2. SHA256SUMS.txt 行数 == 期待数，且每行路径/哈希与磁盘一致，无多余行；
//   3. manifest 里的产物条数 == 期待数，且文件名集合完全一致；
//   4. 没有 `*.sig` 混进上面两项（签名是附加文件，不计入期待数）；
//   5. `--exact`：artifacts 目录下只允许白名单文件（安装包 + 同名 .sig + SHA256SUMS.txt + latest.json），
//      多一个少一个都失败；并把最终会被上传的资产逐条打印出来。上传白名单靠它兜底，
//      不靠 release.yml 的通配有没有写窄。
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EXPECTED_ARTIFACTS, EXPECTED_COUNT, SIGNABLE_IDS, EXPECTED_SIG_COUNT } from "./release-artifacts.mjs";

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : fallback;
};
const dir = resolve(argOf("--dir", "artifacts"));
const manifestPath = argOf("--manifest", null);
const writeSums = argv.includes("--write-sums");
const artifactsOnly = argv.includes("--artifacts-only");
const exact = argv.includes("--exact");

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

// 5) 上传白名单：artifacts 下只允许「每类安装包 1 个 + 同名 .sig + SHA256SUMS.txt + latest.json」
//    少一个在 1) 报；这里负责反过来查「多一个」，并把最终上传清单逐条打出来。
const uploadList = [];
if (exact) {
  const anySig = sigs.length > 0;
  const allowed = new Map();
  for (const { rule, file } of found) {
    allowed.set(file.rel, rule.id);
    // 未启用签名时不把 .sig 放进白名单，否则打印出的上传清单会包含并不存在的文件。
    if (anySig && SIGNABLE_IDS.includes(rule.id)) allowed.set(`${file.rel}.sig`, "sig");
  }
  if (!artifactsOnly) {
    allowed.set("./SHA256SUMS.txt", "sums");
    if (anySig) allowed.set("./latest.json", "latest");
  }

  for (const f of files) {
    if (!allowed.has(f.rel)) errors.push(`多余文件（会被误传进 Release）：${f.rel}`);
  }

  if (anySig && sigs.length !== EXPECTED_SIG_COUNT) {
    errors.push(`签名文件 ${sigs.length} 个 != 可签名产物 ${EXPECTED_SIG_COUNT} 个`);
  }
  if (!artifactsOnly) {
    for (const { rule, file } of found) {
      if (!anySig || !SIGNABLE_IDS.includes(rule.id)) continue;
      if (!files.some((f) => f.rel === `${file.rel}.sig`)) errors.push(`缺少签名：${file.rel}.sig`);
    }
    if (anySig && !files.some((f) => f.rel === "./latest.json")) {
      errors.push("有签名却没有 latest.json（应用内更新清单缺失）");
    }
    if (!anySig && files.some((f) => f.rel === "./latest.json")) {
      errors.push("未启用签名却出现 latest.json");
    }
  }

  uploadList.push(...[...allowed.keys()].sort());

  // manifest 不在 artifacts 下，但它同样会被上传：两份都必须在，缺一份也算「少一个」。
  if (manifestPath) {
    const absJson = resolve(manifestPath);
    const absMd = absJson.replace(/\.json$/, ".md");
    for (const p of [absJson, absMd]) {
      if (!statSync(p, { throwIfNoEntry: false })) errors.push(`缺少待上传清单：${p}`);
      else uploadList.push(p);
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

if (exact) {
  console.log(`[verify] 待上传资产共 ${uploadList.length} 个（白名单逐条核过，多一个少一个都会失败）：`);
  for (const p of uploadList) {
    // SHA256SUMS.txt 是本轮 --write-sums 刚写的，不在启动时的 files 快照里，回落到磁盘查。
    const full = files.find((f) => f.rel === p)?.full ?? resolve(p);
    const size = statSync(full, { throwIfNoEntry: false })?.size;
    console.log(`  ${String(size ?? "-").padStart(10)}  ${p}`);
  }
}
