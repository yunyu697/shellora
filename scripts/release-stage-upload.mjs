// 把 `release-verify.mjs --exact --emit-list` 核过的待上传清单，按 basename 平铺到 dist/。
//
// 为什么要这一步：release.yml 里手写上传路径已经错了两次——先是 `artifacts/**/*` 太宽，
// 把 .app 内部文件、裸二进制、历史 manifest 一起传上去；改成逐条枚举后又因为
// upload-artifact 会剥掉通配路径的公共祖先（真实布局是 artifacts/windows-bundles/nsis/*.exe）
// 而对不上。现在上传路径只有一处来源：verify 输出的清单，YAML 只写 `dist/*`。
//
// 用法：node scripts/release-stage-upload.mjs --list upload-list.json --out dist
//
// 断言（任一不满足即退出码 1，并打印实际清单）：
//   1. 清单条数 == 7 装包 + 6 签名 + SHA256SUMS.txt + latest.json + 2 份 manifest；
//   2. basename 在清单里唯一（Release 资产是平铺的，同名就会互相覆盖）；
//   3. dist/ 里恰好这么多文件、没有子目录；
//   4. 清单里记的字节数、源文件、dist 副本三者一致。

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EXPECTED_COUNT, EXPECTED_SIG_COUNT, EXPECTED_MANIFEST_FILES } from "./release-artifacts.mjs";

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : fallback;
};

const listPath = resolve(argOf("--list", "upload-list.json"));
const outDir = resolve(argOf("--out", "dist"));
const expected =
  EXPECTED_COUNT + EXPECTED_SIG_COUNT + 2 + EXPECTED_MANIFEST_FILES; // 7 + 6 + SUMS + latest + 2 manifest

const errors = [];
const { count, files } = JSON.parse(readFileSync(listPath, "utf8"));

if (count !== files.length) errors.push(`清单自相矛盾：count=${count}，实际 ${files.length} 条`);
if (files.length !== expected) {
  errors.push(
    `清单 ${files.length} 个 != 期望 ${expected} 个（${EXPECTED_COUNT} 装包 + ${EXPECTED_SIG_COUNT} 签名` +
      ` + SHA256SUMS.txt + latest.json + ${EXPECTED_MANIFEST_FILES} 份 manifest）`,
  );
}

const seen = new Map();
for (const f of files) {
  const name = basename(f.path);
  if (seen.has(name)) errors.push(`basename 重复：${name}（${seen.get(name)} 与 ${f.path}）`);
  seen.set(name, f.path);
  const onDisk = statSync(f.path, { throwIfNoEntry: false });
  if (!onDisk) {
    errors.push(`清单里的文件不存在：${f.path}`);
  } else if (onDisk.size !== f.size) {
    errors.push(`清单记的字节数与磁盘不符：${name} 清单 ${f.size} / 磁盘 ${onDisk.size}`);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const f of files) {
  if (statSync(f.path, { throwIfNoEntry: false })) copyFileSync(f.path, join(outDir, basename(f.path)));
}

const entries = readdirSync(outDir, { withFileTypes: true });
const dirs = entries.filter((e) => !e.isFile()).map((e) => e.name);
if (dirs.length) errors.push(`dist/ 里出现子目录：${dirs.join(", ")}`);

const staged = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
if (staged.length !== files.length) errors.push(`dist/ 里 ${staged.length} 个文件 != 清单 ${files.length} 个`);

for (const f of files) {
  const name = basename(f.path);
  const have = statSync(join(outDir, name), { throwIfNoEntry: false })?.size;
  if (have !== f.size) errors.push(`字节数不一致：${name} 清单 ${f.size} / dist ${have ?? "缺失"}`);
}

if (errors.length) {
  console.error(`[stage] FAIL（${errors.length} 项）`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`[stage] dist/ 实际 ${staged.length} 个文件：`);
  for (const n of staged) console.error(`  ${String(statSync(join(outDir, n)).size).padStart(10)}  ${n}`);
  process.exit(1);
}

console.log(`[stage] dist/ 共 ${staged.length} 个文件，无子目录，basename 唯一，字节数与清单一致：`);
for (const n of staged) console.log(`  ${String(statSync(join(outDir, n)).size).padStart(10)}  ${n}`);
