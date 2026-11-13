// 版本号校验：三处版本一致 + 段值规则（非首位 ≤ 10）+ 历史 tag 复核。
// 规则见 docs/VERSIONING.md。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const problems = [];
const notes = [];

const VER = /\b(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(\d+))?\b/g;

function checkSegments(raw, where) {
  VER.lastIndex = 0;
  const m = VER.exec(raw);
  if (!m) return null;
  const segs = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[5] ? Number(m[5]) : null;
  if (segs[1] > 10 || segs[2] > 10) {
    problems.push(`${where}: ${m[0]} 越界（MINOR/PATCH 不得超过 10，应进位到 ${segs[0]}.${segs[1] + 1}.0）`);
  }
  if (pre !== null && pre > 10) problems.push(`${where}: ${m[0]} 预发布序号超过 10`);
  return m[0];
}

// ---- 1. 三处版本一致 ----
const cargo = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const cargoVersion = cargo.match(/^version = "(.+)"$/m)?.[1];
if (!cargoVersion) problems.push("Cargo.toml 缺少 [package] version");
if (pkg.version !== cargoVersion) problems.push(`package.json=${pkg.version} 与 Cargo.toml=${cargoVersion} 不一致`);
if (tauri.version !== cargoVersion) problems.push(`tauri.conf.json=${tauri.version} 与 Cargo.toml=${cargoVersion} 不一致`);
if (cargoVersion) checkSegments(cargoVersion, "版本号");

// ---- 2. 文档与清单里的版本字面量 ----
const docFiles = ["README.md", "docs/VERSIONING.md", "docs/DESIGN.md"];
for (const name of readdirSync(resolve(root, "docs/release")).filter((f) => f.endsWith(".json"))) {
  docFiles.push(`docs/release/${name}`);
}

// 只校验「本项目版本上下文」中的字面量；第三方版本、IP、端口不参与。
const PROJECT_CONTEXT = /Shellora|版本|release|tag|manifest|当前开发版|上一个正式版/;
const THIRD_PARTY = /\b(Qt|Node|Tauri|React|Vite|WebView2|Chrome|russh|serde|tokio|pnpm|npm|Rust|Windows|macOS|Linux)\b/i;
const DEP_LINE = /^\s*["']?[\w@/.-]+["']?\s*[:=]\s*["'][\^~>=<]*\d+\.\d+/;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

function scanFile(file) {
  const abs = resolve(root, file);
  if (!existsSync(abs)) return;
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (IPV4.test(line)) return; // IP 地址整行跳过
    if (DEP_LINE.test(line)) return; // 依赖版本
    if (THIRD_PARTY.test(line) && !/Shellora/.test(line)) return; // 第三方版本
    if (/非法|不允许|反例|错误示例|越界/.test(line)) return; // 文档里的反例
    if (!PROJECT_CONTEXT.test(line)) return;
    VER.lastIndex = 0;
    for (const m of line.matchAll(VER)) {
      const where = `${file}:${i + 1}`;
      const segs = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (segs[1] > 10 || segs[2] > 10) {
        problems.push(`${where}: ${m[0]} 越界（MINOR/PATCH 不得超过 10）`);
      } else {
        notes.push(`${where}: ${m[0]} 合规`);
      }
      if (m[5] && Number(m[5]) > 10) problems.push(`${where}: 预发布序号越界`);
    }
  });
}
for (const f of docFiles) scanFile(f);

// ---- 3. 历史 tag ----
let tags = [];
try {
  tags = execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  notes.push("git tag 读取失败（可能不在 git 仓库）");
}
for (const tag of tags) {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(\d+))?$/);
  if (!m) {
    notes.push(`tag ${tag}: 非三段式，跳过`);
    continue;
  }
  const segs = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (segs[1] > 10 || segs[2] > 10) problems.push(`tag ${tag}: 段值越界`);
  else notes.push(`tag ${tag}: 合规`);
}

if (problems.length) {
  console.error(`版本检查失败：${problems.length} 条`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`版本一致：${cargoVersion}（Cargo.toml / package.json / tauri.conf.json）`);
console.log(`合规字面量：${notes.length} 条；历史 tag：${tags.length} 个；误伤屏蔽：IPv4/依赖/第三方版本`);
