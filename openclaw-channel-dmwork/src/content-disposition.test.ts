import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rfc5987Encode, buildContentDisposition } from "./api-fetch.js";

/**
 * Tests for issue #225 fixes:
 * - extractFilename decoding
 * - buildContentDisposition / rfc5987Encode
 * - uploadFileToCOS Content-Disposition header
 * - channel.ts filename decoding
 */

// ---------------------------------------------------------------------------
// extractFilename — percent-decoding
// ---------------------------------------------------------------------------
describe("extractFilename — percent-decoding", () => {
  // Replicate the extractFilename logic for direct unit testing
  function extractFilename(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split("/");
      const raw = parts[parts.length - 1] || "file";
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    } catch {
      return "file";
    }
  }

  it("ASCII URL returns filename unchanged", () => {
    expect(extractFilename("https://cdn.example.com/path/report.xlsx")).toBe("report.xlsx");
  });

  it("percent-encoded Chinese characters are decoded", () => {
    expect(extractFilename("https://cdn.example.com/path/%E5%AE%A1%E6%9F%A5.xlsx")).toBe("审查.xlsx");
  });

  it("percent-encoded spaces are decoded", () => {
    expect(extractFilename("https://cdn.example.com/path/my%20report.xlsx")).toBe("my report.xlsx");
  });

  it("malformed percent sequence returns raw string", () => {
    expect(extractFilename("https://cdn.example.com/path/file%GG.txt")).toBe("file%GG.txt");
  });

  it("URL with no path returns 'file'", () => {
    expect(extractFilename("https://cdn.example.com/")).toBe("file");
  });

  it("invalid URL returns 'file'", () => {
    expect(extractFilename("not-a-url")).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// channel.ts filename decoding (replicated logic)
// ---------------------------------------------------------------------------
describe("channel.ts filename decoding", () => {
  const path = { basename: (p: string) => p.split("/").pop() || "" };

  function decodeFilename(mediaUrl: string): string {
    const urlPath = new URL(mediaUrl).pathname;
    const rawFilename = path.basename(urlPath) || "file";
    try {
      return decodeURIComponent(rawFilename);
    } catch {
      return rawFilename;
    }
  }

  it("decodes percent-encoded Chinese filename from URL", () => {
    expect(decodeFilename("https://cdn.example.com/uploads/%E5%AE%A1%E6%9F%A5.xlsx")).toBe("审查.xlsx");
  });

  it("keeps ASCII filename unchanged", () => {
    expect(decodeFilename("https://cdn.example.com/uploads/report.xlsx")).toBe("report.xlsx");
  });

  it("decodes spaces in filename", () => {
    expect(decodeFilename("https://cdn.example.com/uploads/my%20file.txt")).toBe("my file.txt");
  });
});

// ---------------------------------------------------------------------------
// rfc5987Encode — unit tests (imported from api-fetch)
// ---------------------------------------------------------------------------
describe("rfc5987Encode", () => {
  it("encodes apostrophe", () => {
    expect(rfc5987Encode("John's")).toBe("John%27s");
  });

  it("encodes parens", () => {
    expect(rfc5987Encode("file(1)")).toBe("file%281%29");
  });

  it("encodes asterisk", () => {
    expect(rfc5987Encode("draft*")).toBe("draft%2A");
  });

  it("preserves exclamation mark (in attr-char)", () => {
    expect(rfc5987Encode("urgent!")).toBe("urgent!");
  });

  it("encodes spaces as %20", () => {
    expect(rfc5987Encode("my file")).toBe("my%20file");
  });

  it("encodes Chinese characters", () => {
    expect(rfc5987Encode("审查")).toBe("%E5%AE%A1%E6%9F%A5");
  });
});

// ---------------------------------------------------------------------------
// buildContentDisposition — unit tests (imported from api-fetch)
// ---------------------------------------------------------------------------
describe("buildContentDisposition", () => {
  it("ASCII safe filename — simple format", () => {
    expect(buildContentDisposition("report.xlsx")).toBe('attachment; filename="report.xlsx"');
  });

  it("ASCII with quotes — falls back to download.ext + filename*", () => {
    const result = buildContentDisposition('report"v2.xlsx');
    expect(result).toContain('filename="download.xlsx"');
    expect(result).toContain("filename*=UTF-8''report%22v2.xlsx");
  });

  it("ASCII with backslash — falls back", () => {
    const result = buildContentDisposition("file\\path.txt");
    expect(result).toContain('filename="download.txt"');
    expect(result).toContain("filename*=UTF-8''");
  });

  it("ASCII with semicolon — falls back", () => {
    const result = buildContentDisposition("file;name.txt");
    expect(result).toContain('filename="download.txt"');
    expect(result).toContain("filename*=UTF-8''");
  });

  it("non-ASCII (Chinese) — uses download.ext + filename*", () => {
    const result = buildContentDisposition("审查.xlsx");
    expect(result).toBe(`attachment; filename="download.xlsx"; filename*=UTF-8''${encodeURIComponent("审查")}.xlsx`);
  });

  it("mixed ASCII + Chinese — uses download.ext + filename*", () => {
    const result = buildContentDisposition("Q3审查_report.xlsx");
    expect(result).toContain('filename="download.xlsx"');
    expect(result).toContain("filename*=UTF-8''");
  });

  it("ASCII with apostrophe — treated as safe (apostrophe is valid in quoted-string)", () => {
    expect(buildContentDisposition("John's Report.xlsx")).toBe(`attachment; filename="John's Report.xlsx"`);
  });

  it("non-ASCII + apostrophe — apostrophe encoded in filename*", () => {
    const result = buildContentDisposition("审查's.xlsx");
    expect(result).toContain("filename*=UTF-8''");
    expect(result).toContain("%27");  // apostrophe encoded
  });

  it("filename with parens and asterisk — safe in quoted-string", () => {
    const result = buildContentDisposition("file(draft)*.xlsx");
    expect(result).toBe('attachment; filename="file(draft)*.xlsx"');
  });

  it("no extension — download fallback has no extension", () => {
    const result = buildContentDisposition("审查报告");
    expect(result).toContain('filename="download"');
    expect(result).toContain("filename*=UTF-8''");
  });

  it("defaults to attachment disposition type", () => {
    expect(buildContentDisposition("report.xlsx")).toMatch(/^attachment;/);
  });

  it("supports inline disposition type", () => {
    expect(buildContentDisposition("video.mp4", "inline")).toBe('inline; filename="video.mp4"');
  });

  it("inline with non-ASCII filename uses download fallback", () => {
    const result = buildContentDisposition("视频.mp4", "inline");
    expect(result).toMatch(/^inline;/);
    expect(result).toContain('filename="download.mp4"');
    expect(result).toContain("filename*=UTF-8''");
  });
});

// ---------------------------------------------------------------------------
// uploadFileToCOS — Content-Disposition integration
// ---------------------------------------------------------------------------
describe("uploadFileToCOS Content-Disposition", () => {
  it("sets attachment ContentDisposition for document type", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/file.xlsx",
      fileBody: Buffer.from("data"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "report.xlsx",
    });

    expect(capturedParams.ContentDisposition).toBe('attachment; filename="report.xlsx"');
  });

  it("sets attachment ContentDisposition with RFC 5987 for non-ASCII filename", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/file.xlsx",
      fileBody: Buffer.from("data"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "审查.xlsx",
    });

    expect(capturedParams.ContentDisposition).toContain('filename="download.xlsx"');
    expect(capturedParams.ContentDisposition).toContain("filename*=UTF-8''");
    expect(capturedParams.ContentDisposition).toContain("%E5%AE%A1%E6%9F%A5");
  });

  it("does NOT set ContentDisposition for image type", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/image.png",
      fileBody: Buffer.from("data"),
      contentType: "image/png",
      filename: "photo.png",
    });

    expect(capturedParams.ContentDisposition).toBeUndefined();
  });

  it("sets inline ContentDisposition for video type", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/video.mp4",
      fileBody: Buffer.from("data"),
      contentType: "video/mp4",
      filename: "meeting.mp4",
    });

    expect(capturedParams.ContentDisposition).toBe('inline; filename="meeting.mp4"');
  });

  it("sets inline ContentDisposition for audio type", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/audio.mp3",
      fileBody: Buffer.from("data"),
      contentType: "audio/mpeg",
      filename: "recording.mp3",
    });

    expect(capturedParams.ContentDisposition).toBe('inline; filename="recording.mp3"');
  });

  it("sets inline ContentDisposition with RFC 5987 for non-ASCII video filename", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/video.mp4",
      fileBody: Buffer.from("data"),
      contentType: "video/mp4",
      filename: "会议录像.mp4",
    });

    expect(capturedParams.ContentDisposition).toMatch(/^inline;/);
    expect(capturedParams.ContentDisposition).toContain('filename="download.mp4"');
    expect(capturedParams.ContentDisposition).toContain("filename*=UTF-8''");
  });

  it("does NOT set ContentDisposition when filename is not provided", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/file.txt",
      fileBody: Buffer.from("data"),
      contentType: "text/plain",
    });

    expect(capturedParams.ContentDisposition).toBeUndefined();
  });

  it("handles filename with apostrophe in RFC 5987 encoding", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/file.xlsx",
      fileBody: Buffer.from("data"),
      contentType: "application/octet-stream",
      filename: "审查's.xlsx",
    });

    // Non-ASCII + apostrophe: apostrophe must be encoded as %27
    expect(capturedParams.ContentDisposition).toContain("%27");
    expect(capturedParams.ContentDisposition).toContain("filename*=UTF-8''");
  });

  it("sets attachment for application/pdf", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/doc.pdf",
      fileBody: Buffer.from("data"),
      contentType: "application/pdf",
      filename: "report.pdf",
    });

    expect(capturedParams.ContentDisposition).toBe('attachment; filename="report.pdf"');
  });

  it("sets attachment for text/plain", async () => {
    let capturedParams: any = null;

    vi.resetModules();
    vi.doMock("cos-nodejs-sdk-v5", () => ({
      default: class FakeCOS {
        putObject(params: any, cb: any) {
          capturedParams = params;
          cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
        }
      },
    }));

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/file.txt",
      fileBody: Buffer.from("data"),
      contentType: "text/plain",
      filename: "notes.txt",
    });

    expect(capturedParams.ContentDisposition).toBe('attachment; filename="notes.txt"');
  });
});
