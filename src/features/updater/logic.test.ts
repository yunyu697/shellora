import { describe, expect, it } from "vitest";
import {
  classifyError,
  extractManifestSize,
  formatBytes,
  formatDate,
  progressPercent,
  targetsFor,
} from "./logic";

describe("updater 错误码", () => {
  it("签名校验失败归 UPD-03", () => {
    const info = classifyError(
      new Error("Signature verification failed: signature mismatch"),
      "download",
    );
    expect(info.code).toBe("UPD-03");
    expect(info.message).toContain("Signature");
  });

  it("签名不匹配优先于下载阶段兜底", () => {
    expect(classifyError("minisign signature does not match public key", "download").code).toBe(
      "UPD-03",
    );
  });

  it("清单缺失/平台不匹配归 UPD-02", () => {
    expect(classifyError("TargetsNotFound([\"windows-x86_64\"])", "check").code).toBe("UPD-02");
    expect(classifyError("update endpoint returned 404", "check").code).toBe("UPD-02");
  });

  it("网络类错误归 UPD-01", () => {
    expect(classifyError("error sending request: connection timed out", "check").code).toBe(
      "UPD-01",
    );
  });

  it("下载与安装阶段有各自的兜底码", () => {
    expect(classifyError("unexpected EOF", "download").code).toBe("UPD-04");
    expect(classifyError("installer exited with code 1", "install").code).toBe("UPD-05");
    expect(classifyError("boom", "check").code).toBe("UPD-99");
  });
});

describe("体积与进度", () => {
  it("格式化字节", () => {
    expect(formatBytes(5_777_706)).toBe("5.5 MB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(undefined)).toBe("未知");
  });

  it("进度百分比并夹紧范围", () => {
    expect(progressPercent(50, 100)).toBe(50);
    expect(progressPercent(200, 100)).toBe(100);
    expect(progressPercent(10, null)).toBeNull();
  });

  it("从 latest.json 平台条目读取体积", () => {
    const raw = {
      platforms: {
        "windows-x86_64": { size: 5_777_706, signature: "sig", url: "u" },
        "darwin-aarch64": { size: 16_272_540, signature: "sig", url: "u" },
      },
    };
    expect(extractManifestSize(raw, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(5_777_706);
    expect(extractManifestSize(raw, "Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(16_272_540);
    expect(extractManifestSize({}, "Mozilla/5.0 (X11; Linux x86_64)")).toBeUndefined();
  });

  it("平台 target 键按系统选择", () => {
    expect(targetsFor("Mozilla/5.0 (Windows NT 10.0)")[0]).toBe("windows-x86_64");
    expect(targetsFor("Mozilla/5.0 (Macintosh)")[0]).toBe("darwin-aarch64");
    expect(targetsFor("Mozilla/5.0 (X11; Linux x86_64)")[0]).toBe("linux-x86_64");
  });
});

describe("日期", () => {
  it("RFC3339 转本地日期", () => {
    expect(formatDate("2026-11-05T12:00:00Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatDate(null)).toBe("");
  });
});
