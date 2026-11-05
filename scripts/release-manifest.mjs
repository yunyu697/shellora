// 扫描打包产物目录，生成 SHA-256 清单（JSON + Markdown），供 Release 页面粘贴。
// 用法：node scripts/release-manifest.mjs [--dir src-tauri/target/release/bundle]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argDir = process.argv.indexOf("--dir");
const bundleDir = resolve(
  root,
  argDir > -1 ? process.argv[argDir + 1] : "src-tauri/target/release/bundle",
);
const version = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8")).version;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push({ path: full, size: st.size });
  }
  return out;
}

if (!statSync(bundleDir, { throwIfNoEntry: false })) {
  console.error(`产物目录不存在：${bundleDir}`);
  process.exit(1);
}

const artifacts = walk(bundleDir)
  .filter((f) => !/\.(sig|json)$/.test(f.path))
  .map((f) => {
    const bytes = readFileSync(f.path);
    return {
      path: f.path.replaceAll("\\", "/").replace(`${root.replaceAll("\\", "/")}/`, ""),
      name: basename(f.path),
      bytes: f.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });

// 裸二进制（未打包的 release 可执行文件）同样纳入清单。
const profileDir = resolve(bundleDir, "..");
for (const name of ["shellora.exe", "shellora"]) {
  const full = join(profileDir, name);
  if (!statSync(full, { throwIfNoEntry: false })) continue;
  const bytes = readFileSync(full);
  artifacts.push({
    path: full.replaceAll("\\", "/").replace(`${root.replaceAll("\\", "/")}/`, ""),
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  break;
}

// 旧品牌（改名前的 SSHTerm）产物保留在 bundle 目录供回溯，但不随本版发布。
const legacy = artifacts.filter((a) => a.name.startsWith("SSHTerm"));
const current = artifacts.filter((a) => !a.name.startsWith("SSHTerm"));
for (const a of legacy) a.legacy = true;

const outDir = resolve(root, "docs/release");
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, `manifest-${version}.json`);
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      version,
      license: "MIT",
      thirdPartyNotices: "THIRD_PARTY_NOTICES.md",
      generatedAt: new Date().toISOString(),
      artifacts,
    },
    null,
    2,
  ),
);

const table = (rows) =>
  rows
    .map((a) => `| \`${a.name}\` | ${a.bytes.toLocaleString("en-US")} | \`${a.sha256}\` |`)
    .join("\n");
const md = `# Release ${version} 产物清单

- 版本来源：\`src-tauri/Cargo.toml\` → \`package.json\` / \`tauri.conf.json\`（\`scripts/check-version.mjs\` 校验）
- 生成时间：${new Date().toISOString()}

| 文件 | 字节 | SHA-256 |
|---|---:|---|
${table(current)}
${
  legacy.length
    ? `
## 旧品牌产物（保留备查，不随本版发布）

改名前的 \`SSHTerm\` 安装包仍在 \`bundle\` 目录下（未删除，便于回溯），不要上传到 Release。

| 文件 | 字节 | SHA-256 |
|---|---:|---|
${table(legacy)}
`
    : ""
}`;
const mdPath = join(outDir, `manifest-${version}.md`);
writeFileSync(mdPath, md);
console.log(`已生成 ${jsonPath}（${artifacts.length} 个产物）`);
console.log(`已生成 ${mdPath}`);
