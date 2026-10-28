import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { resolveDirs } from "./paths.js";
import { openStore } from "./db.js";
import { saveInbound } from "./store.js";
import { exportArchive, loadProjects, resolveProjectByCwd } from "./project.js";
import { EnvelopeSchema } from "../contract/envelope.js";
import type { Envelope } from "../contract/envelope.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "amail-proj-"));
  const dirs = resolveDirs({ AMAIL_HOME: home });
  return { home, dirs };
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return EnvelopeSchema.parse({
    v: 1,
    id: `msg_${ulid()}`,
    from: "alice@other-dev",
    to: "bob@this-dev",
    subject: "归档测试",
    inReplyTo: null,
    references: [],
    createdAt: new Date().toISOString(),
    claim: { name: "alice", email: "alice@example.com" },
    seal: { alg: "x25519-aes256gcm", epk: "epk", iv: "iv", body: "sealed" },
    attachments: [],
    sig: "c2ln",
    ...overrides,
  });
}

describe("resolveProjectByCwd", () => {
  it("realpath 全等匹配（经 symlink 命中）", () => {
    const { home, dirs } = setup();
    const repo = join(home, "repo");
    mkdirSync(repo);
    const alias = join(home, "repo-alias");
    symlinkSync(repo, alias);
    mkdirSync(dirs.projectsDir, { recursive: true });
    writeFileSync(
      join(dirs.projectsDir, "acme.json"),
      JSON.stringify({ name: "Acme", repos: [repo], archiveDir: join(home, "archive") }),
    );

    expect(resolveProjectByCwd(dirs, alias)?.slug).toBe("acme");
    expect(resolveProjectByCwd(dirs, repo)?.slug).toBe("acme");
    expect(resolveProjectByCwd(dirs, home)).toBeUndefined();
  });

  it("无登记时返回 undefined；loadProjects 列出全部", () => {
    const { dirs } = setup();
    expect(loadProjects(dirs)).toEqual([]);
    expect(resolveProjectByCwd(dirs, dirs.home)).toBeUndefined();
  });
});

describe("exportArchive", () => {
  it("导出 md + 复制附件；不动存储真源", () => {
    const { home, dirs } = setup();
    const archiveDir = join(home, "archive");
    const repo = join(home, "repo");
    mkdirSync(repo);
    writeFileSync(
      join(dirs.projectsDir, "acme.json"),
      JSON.stringify({ name: "Acme", repos: [repo], archiveDir }),
    );

    const db = openStore(dirs.storePath);
    const attDir = join(dirs.attachmentsDir, "att_1");
    mkdirSync(attDir, { recursive: true });
    const blob = join(attDir, "data.bin");
    writeFileSync(blob, "hello-bytes");

    const env = envelope({
      attachments: [{ id: "att_01M61A7ADP7K8BHXT1DR1Y9E7R", name: "data.bin", sha256: "a".repeat(64), size: 11 }],
    });
    saveInbound(
      db,
      env,
      {
        body: "正文内容",
        handoffJson: JSON.stringify({ progress: "p", description: "d", questions: ["q?"] }),
        attachments: [{ id: "att_01M61A7ADP7K8BHXT1DR1Y9E7R", blobPath: blob }],
      },
      { sigValid: true },
    );

    const mdPath = exportArchive(dirs, db, env.id, "acme");
    expect(existsSync(mdPath)).toBe(true);
    const md = readFileSync(mdPath, "utf8");
    expect(md).toContain("归档测试");
    expect(md).toContain("正文内容");
    expect(md).toContain("Handoff");
    const copied = join(archiveDir, "attachments", env.id, `${"a".repeat(8)}-data.bin`);
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, "utf8")).toBe("hello-bytes");
    // 原文元数据保留原名
    expect(md).toContain("data.bin");
    // 真源仍在
    expect(existsSync(blob)).toBe(true);
  });

  it("恶意附件名（路径穿越）拒绝落盘：不写 archive 之外，正文标记未导出", () => {
    const { home, dirs } = setup();
    const archiveDir = join(home, "archive");
    const repo = join(home, "repo");
    mkdirSync(repo);
    writeFileSync(
      join(dirs.projectsDir, "acme.json"),
      JSON.stringify({ name: "Acme", repos: [repo], archiveDir }),
    );
    const db = openStore(dirs.storePath);
    const blob = join(dirs.attachmentsDir, "evil.bin");
    mkdirSync(dirs.attachmentsDir, { recursive: true });
    writeFileSync(blob, "evil-bytes");

    const env = envelope({
      attachments: [
        {
          id: "att_01M61A7ADP7K8BHXT1DR1Y9E7S",
          name: "../../evil.txt",
          sha256: "b".repeat(64),
          size: 10,
        },
      ],
    });
    saveInbound(
      db,
      env,
      { body: "x", attachments: [{ id: "att_01M61A7ADP7K8BHXT1DR1Y9E7S", blobPath: blob }] },
      { sigValid: true },
    );

    const mdPath = exportArchive(dirs, db, env.id, "acme");
    const md = readFileSync(mdPath, "utf8");
    expect(md).toContain("../../evil.txt");
    expect(md).toContain("未导出");

    const attDir = join(archiveDir, "attachments", env.id);
    expect(existsSync(join(home, "evil.txt"))).toBe(false);
    expect(existsSync(join(archiveDir, "attachments", "evil.txt"))).toBe(false);
    expect(existsSync(attDir) ? readdirSync(attDir) : []).toEqual([]);
  });

  it("247 字符长名可归档：落盘名按字节截断（≤200），元数据保留原名", () => {
    const { home, dirs } = setup();
    const archiveDir = join(home, "archive");
    const repo = join(home, "repo");
    mkdirSync(repo);
    writeFileSync(
      join(dirs.projectsDir, "acme.json"),
      JSON.stringify({ name: "Acme", repos: [repo], archiveDir }),
    );
    const db = openStore(dirs.storePath);
    const blob = join(dirs.attachmentsDir, "long.bin");
    mkdirSync(dirs.attachmentsDir, { recursive: true });
    writeFileSync(blob, "long-bytes");

    const longName = `${"a".repeat(243)}.bin`; // 247 字符
    const env = envelope({
      attachments: [{ id: "att_01M61A7ADP7K8BHXT1DR1Y9E7T", name: longName, sha256: "c".repeat(64), size: 10 }],
    });
    saveInbound(
      db,
      env,
      { body: "x", attachments: [{ id: "att_01M61A7ADP7K8BHXT1DR1Y9E7T", blobPath: blob }] },
      { sigValid: true },
    );

    const mdPath = exportArchive(dirs, db, env.id, "acme");
    const attDir = join(archiveDir, "attachments", env.id);
    const files = readdirSync(attDir);
    expect(files).toHaveLength(1);
    const stored = files[0]!;
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(200);
    expect(stored.startsWith("cccccccc-")).toBe(true);
    expect(readFileSync(join(attDir, stored), "utf8")).toBe("long-bytes");
    // 原名完整保留在正文元数据
    expect(readFileSync(mdPath, "utf8")).toContain(longName);
  });

  it("中文长名按 UTF-8 字节截断，不截断多字节字符中途", () => {
    const { home, dirs } = setup();
    const archiveDir = join(home, "archive");
    const repo = join(home, "repo");
    mkdirSync(repo);
    writeFileSync(
      join(dirs.projectsDir, "acme.json"),
      JSON.stringify({ name: "Acme", repos: [repo], archiveDir }),
    );
    const db = openStore(dirs.storePath);
    const blob = join(dirs.attachmentsDir, "cn.bin");
    mkdirSync(dirs.attachmentsDir, { recursive: true });
    writeFileSync(blob, "cn-bytes");

    const longName = `${"测试".repeat(100)}.txt`; // 600+ 字节
    const env = envelope({
      attachments: [{ id: "att_01M61A7ADP7K8BHXT1DR1Y9E7V", name: longName, sha256: "d".repeat(64), size: 8 }],
    });
    saveInbound(
      db,
      env,
      { body: "x", attachments: [{ id: "att_01M61A7ADP7K8BHXT1DR1Y9E7V", blobPath: blob }] },
      { sigValid: true },
    );

    const mdPath = exportArchive(dirs, db, env.id, "acme");
    const attDir = join(archiveDir, "attachments", env.id);
    const files = readdirSync(attDir);
    expect(files).toHaveLength(1);
    const stored = files[0]!;
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(200);
    expect(stored).not.toContain("\uFFFD");
    // 合法 UTF-8：编码回读与落盘名全等（半个字符会变成替换符）
    expect(Buffer.from(stored, "utf8").toString("utf8")).toBe(stored);
    expect(stored.startsWith("dddddddd-测试")).toBe(true);
    expect(readFileSync(join(attDir, stored), "utf8")).toBe("cn-bytes");
    expect(readFileSync(mdPath, "utf8")).toContain(longName);
  });

  it("未知 project / 未知 message 抛错", () => {
    const { dirs } = setup();
    const db = openStore(dirs.storePath);
    expect(() => exportArchive(dirs, db, "msg_x", "nope")).toThrow(/unknown project/);
  });
});
