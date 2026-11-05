// 生成 Tauri Updater 的 latest.json（GitHub Releases 静态更新源）。
//
// 输入：打包产物目录中的 `*.sig`（tauri build 在 createUpdaterArtifacts=true 时生成）。
// 输出：latest.json，供 endpoints 指定的 URL 直接下载。
//
// 用法：
//   node scripts/updater-manifest.mjs [--dir <产物目录>] [--out <文件>] \
//     [--base-url <Release 下载前缀>] [--notes <文本>] [--version <版本>] [--require]
//
// 未找到任何 .sig 时默认跳过（不阻断未配置签名密钥的构建）；--require 时视为失败。
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configVersion = JSON.parse(
  readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
).version;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : fallback;
}

const version = arg("--version", configVersion);

const inputDir = resolve(root, arg("--dir", "src-tauri/target/release/bundle"));
const outFile = resolve(root, arg("--out", "docs/release/latest.json"));
const baseUrl = arg(
  "--base-url",
  `https://github.com/yunyu697/shellora/releases/download/v${version}/`,
);
const required = process.argv.includes("--require");

function walk(dir) {
  const out = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(inputDir);
const signatures = files.filter((f) => f.endsWith(".sig"));
if (signatures.length === 0) {
  const message = `未在 ${inputDir} 找到 .sig（未启用签名或未生成 updater 产物），跳过 latest.json。`;
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

/** @type {Record<string, {signature: string, url: string, size: number}>} */
const platforms = {};

function add(key, artifact, signature) {
  platforms[key] = {
    signature: readFileSync(signature, "utf8").trim(),
    url: baseUrl + encodeURIComponent(basename(artifact)),
    size: statSync(artifact).size,
  };
}

for (const sig of signatures) {
  const artifact = sig.slice(0, -".sig".length);
  if (!statSync(artifact, { throwIfNoEntry: false })) {
    console.warn(`跳过孤立的签名文件：${sig}`);
    continue;
  }
  const name = basename(artifact).toLowerCase();
  if (name.endsWith(".exe")) {
    add("windows-x86_64", artifact, sig);
    add("windows-x86_64-nsis", artifact, sig);
  } else if (name.endsWith(".msi")) {
    add("windows-x86_64-msi", artifact, sig);
  } else if (name.endsWith(".app.tar.gz")) {
    // 发布流程构建 universal 包，两个 macOS 架构指向同一产物。
    add("darwin-aarch64", artifact, sig);
    add("darwin-x86_64", artifact, sig);
  } else if (name.endsWith(".appimage")) {
    add("linux-x86_64", artifact, sig);
    add("linux-x86_64-appimage", artifact, sig);
  } else if (name.endsWith(".deb")) {
    add("linux-x86_64-deb", artifact, sig);
  } else if (name.endsWith(".rpm")) {
    add("linux-x86_64-rpm", artifact, sig);
  } else {
    console.warn(`忽略未知更新产物类型：${artifact}`);
  }
}

if (Object.keys(platforms).length === 0) {
  console.error("已找到签名文件，但没有可识别的安装包（exe/msi/app.tar.gz/AppImage/deb/rpm）。");
  process.exit(1);
}

let notes = arg("--notes", process.env.UPDATER_NOTES ?? "");
if (!notes) {
  const notesFile = resolve(root, `docs/release/notes-${version}.md`);
  notes = statSync(notesFile, { throwIfNoEntry: false })
    ? readFileSync(notesFile, "utf8").trim()
    : "请查看 GitHub Release 页面了解本版本变更。";
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已生成 ${outFile}`);
console.log(`版本 ${version}，平台：${Object.keys(platforms).join(", ")}`);
