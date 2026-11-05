// 版本号一致性校验：Cargo.toml 是唯一来源，package.json 与 tauri.conf.json 必须一致。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cargo = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));

const cargoVersion = cargo.match(/^version = "(.+)"$/m)?.[1];
const problems = [];
if (!cargoVersion) problems.push("Cargo.toml 缺少 [package] version");
if (pkg.version !== cargoVersion) problems.push(`package.json=${pkg.version}`);
if (tauri.version !== cargoVersion) problems.push(`tauri.conf.json=${tauri.version}`);

if (problems.length) {
  console.error(`版本不一致：Cargo.toml=${cargoVersion}，${problems.join("，")}`);
  process.exit(1);
}
console.log(`版本一致：${cargoVersion}（Cargo.toml / package.json / tauri.conf.json）`);
