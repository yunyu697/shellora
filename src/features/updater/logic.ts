// 更新流程的纯函数：错误码映射、体积解析、进度换算。
// 与 UI 解耦，便于单元测试；所有文案面向用户。

export type UpdateStage = "check" | "download" | "install";

export interface UpdateErrorInfo {
  /** 稳定的错误码，便于用户反馈与日志检索。 */
  code: "UPD-01" | "UPD-02" | "UPD-03" | "UPD-04" | "UPD-05" | "UPD-99";
  title: string;
  message: string;
}

const ERROR_TEXT: Record<UpdateErrorInfo["code"], { title: string; hint: string }> = {
  "UPD-01": {
    title: "网络请求失败",
    hint: "请检查网络或代理设置后重试。",
  },
  "UPD-02": {
    title: "更新源不可用",
    hint: "更新源没有当前平台的版本清单，请稍后重试或手动下载。",
  },
  "UPD-03": {
    title: "签名校验失败",
    hint: "安装包签名与内置公钥不匹配，已拒绝安装。请勿继续使用该更新源。",
  },
  "UPD-04": {
    title: "下载失败",
    hint: "下载中断或安装包不完整，请重试。",
  },
  "UPD-05": {
    title: "安装失败",
    hint: "安装程序未能启动，请重试或手动下载安装包。",
  },
  "UPD-99": {
    title: "未知错误",
    hint: "请重试；若持续失败，请附带错误码反馈。",
  },
};

export function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const dto = error as { message?: string; code?: string } | null | undefined;
  return dto?.message ?? dto?.code ?? String(error);
}

/**
 * 把插件抛出的错误归类为稳定错误码。
 * 插件错误文本不保证稳定，因此只在匹配到明确特征时才归因；
 * 下载/安装阶段剩余错误按阶段兜底，避免把「网络失败」误报成「签名失败」。
 */
export function classifyError(error: unknown, stage: UpdateStage): UpdateErrorInfo {
  const message = messageOf(error);
  const lower = message.toLowerCase();

  const sig =
    lower.includes("signature") ||
    lower.includes("verify") ||
    lower.includes("verification") ||
    lower.includes("minisign") ||
    lower.includes("public key") ||
    lower.includes("trusted comment");
  const manifest =
    lower.includes("release not found") ||
    lower.includes("target not found") ||
    lower.includes("targetsnotfound") ||
    lower.includes("targets not found") ||
    lower.includes("unsupported os") ||
    lower.includes("invalid release") ||
    lower.includes("deserialize") ||
    lower.includes("no content") ||
    lower.includes("404");
  const network =
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("network") ||
    lower.includes("connect") ||
    lower.includes("dns") ||
    lower.includes("request") ||
    lower.includes("tls");

  let code: UpdateErrorInfo["code"];
  if (sig) code = "UPD-03";
  else if (manifest) code = "UPD-02";
  else if (network) code = "UPD-01";
  else if (stage === "download") code = "UPD-04";
  else if (stage === "install") code = "UPD-05";
  else code = "UPD-99";

  return {
    code,
    title: ERROR_TEXT[code].title,
    message: message || ERROR_TEXT[code].hint,
  };
}

/** 字节数展示：MB 保留一位小数，KB 取整。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "未知";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 下载进度：0–100；总量未知时返回 null（UI 显示不确定进度条）。 */
export function progressPercent(downloaded: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
}

/** 当前平台在 latest.json 中可能使用的 target 键（按优先级）。 */
export function targetsFor(userAgent: string): string[] {
  const ua = userAgent.toLowerCase();
  if (ua.includes("win")) return ["windows-x86_64", "windows-x86_64-nsis", "windows-x86_64-msi"];
  if (ua.includes("mac") || ua.includes("darwin")) {
    return ["darwin-aarch64", "darwin-x86_64", "darwin-universal"];
  }
  return ["linux-x86_64", "linux-x86_64-appimage"];
}

/**
 * 从 latest.json 的原始响应中读取安装包体积。
 * latest.json 官方 schema 没有 size 字段；发布脚本会额外写入 `platforms[*].size`，
 * 插件通过 `Update.rawJson` 原样透传，因此可用于展示。缺失时返回 undefined。
 */
export function extractManifestSize(
  rawJson: unknown,
  userAgent: string,
): number | undefined {
  const root = rawJson as {
    size?: unknown;
    platforms?: Record<string, { size?: unknown } | undefined>;
  } | null;
  if (!root) return undefined;

  for (const key of targetsFor(userAgent)) {
    const size = root.platforms?.[key]?.size;
    if (typeof size === "number" && Number.isFinite(size) && size > 0) return size;
  }
  if (typeof root.size === "number" && Number.isFinite(root.size) && root.size > 0) {
    return root.size;
  }
  return undefined;
}

/** 把 RFC 3339 日期转成本地 `YYYY-MM-DD`；解析失败时原样返回。 */
export function formatDate(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
