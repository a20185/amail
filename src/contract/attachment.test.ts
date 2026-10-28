import { describe, expect, it } from "vitest";
import {
  AttachmentMetaSchema,
  ArtifactMetaSchema,
} from "./attachment.js";

const attachment = {
  id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
  name: "progress.md",
  sha256: "a".repeat(64),
  size: 1234,
};

const artifact = {
  artifactId: "art_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
  name: "report.pdf",
  mime: "application/pdf",
  size: 2048,
  note: "weekly",
  tags: ["report"],
  sha256: "b".repeat(64),
};

describe("AttachmentMetaSchema", () => {
  it("round-trips", () => {
    expect(AttachmentMetaSchema.parse(attachment)).toEqual(attachment);
  });
  it.each([
    ["missing name", { ...attachment, name: undefined }],
    ["wrong size type", { ...attachment, size: "1234" }],
    ["bad sha256", { ...attachment, sha256: "xyz" }],
    ["bad id prefix", { ...attachment, id: "nope_01JD2YWBN5GQXJSQ9P7RJ3TBEM" }],
  ])("rejects %s", (_l, bad) => {
    expect(() => AttachmentMetaSchema.parse(bad)).toThrow();
  });
});

describe("ArtifactMetaSchema", () => {
  it("round-trips", () => {
    expect(ArtifactMetaSchema.parse(artifact)).toEqual(artifact);
  });
  it("accepts missing optional note", () => {
    const { note: _note, ...rest } = artifact;
    expect(ArtifactMetaSchema.parse(rest)).toEqual(rest);
  });
  it.each([
    ["missing sha256", { ...artifact, sha256: undefined }],
    ["wrong size type", { ...artifact, size: -1 }],
    ["bad artifactId", { ...artifact, artifactId: "art_short" }],
    ["missing tags", { ...artifact, tags: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => ArtifactMetaSchema.parse(bad)).toThrow();
  });
});
