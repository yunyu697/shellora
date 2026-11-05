// 本地更新源模拟器（仅用于验证 updater 流程，不参与发布）。
// 用法：node scripts/updater-sim.mjs [port]
//   GET /latest.json                        -> .updater-fixture/latest.json
//   GET /Shellora_1.0.3_x64-setup.exe       -> 正常安装包（限速分块，便于观察进度）
//   若存在 .updater-fixture/BAD 标记，则改为返回同名的篡改文件，用于验证签名拒绝。
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const port = Number(process.argv[2] ?? 8787);
const root = resolve(import.meta.dirname, "..", ".updater-fixture");
const artifact = "Shellora_1.0.3_x64-setup.exe";
const badMarker = join(root, "tamper.flag");

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function sendThrottled(res, file) {
  const size = statSync(file).size;
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": size,
    "cache-control": "no-store",
  });
  const stream = createReadStream(file, { highWaterMark: 256 * 1024 });
  stream.on("data", (chunk) => {
    stream.pause();
    res.write(chunk);
    setTimeout(() => stream.resume(), 90);
  });
  stream.on("end", () => res.end());
  stream.on("error", () => res.destroy());
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, JSON.stringify({ error: "method not allowed" }), 405);
    return;
  }
  console.log(`${req.method} ${url.pathname}${existsSync(badMarker) ? " (BAD)" : ""}`);

  if (url.pathname === "/latest.json") {
    sendJson(res, readFileSync(join(root, "latest.json"), "utf8"));
    return;
  }
  if (url.pathname === `/${artifact}`) {
    const file = existsSync(badMarker) ? join(root, "bad", artifact) : join(root, artifact);
    if (!existsSync(file)) {
      sendJson(res, JSON.stringify({ error: "artifact missing" }), 404);
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": statSync(file).size });
      res.end();
      return;
    }
    sendThrottled(res, file);
    return;
  }
  sendJson(res, JSON.stringify({ error: "not found" }), 404);
}).listen(port, "127.0.0.1", () => {
  console.log(`updater-sim listening on http://127.0.0.1:${port}`);
});
