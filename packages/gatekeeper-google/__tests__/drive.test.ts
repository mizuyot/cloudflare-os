import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDriveListQuery, buildDriveSearchQuery, chunkIds, driveFolderUrl, escapeDriveQueryLiteral,
  parseDriveFolderId,
} from "../src/drive-url.ts";

describe("parseDriveFolderId", () => {
  it("reads a standard folder URL", () => {
    assert.equal(
      parseDriveFolderId("https://drive.google.com/drive/folders/abc123"),
      "abc123",
    );
  });

  it("reads a /drive/u/0/folders URL and ignores query flags", () => {
    assert.equal(
      parseDriveFolderId("https://drive.google.com/drive/u/0/folders/xyz?usp=drive_link"),
      "xyz",
    );
  });

  it("rejects non-folder Drive URLs", () => {
    assert.equal(parseDriveFolderId("https://drive.google.com/file/d/abc/view"), null);
    assert.equal(parseDriveFolderId("https://docs.google.com/document/d/abc/edit"), null);
  });
});

describe("drive query builders", () => {
  it("escapes quotes in literals", () => {
    assert.equal(escapeDriveQueryLiteral("o'reilly"), "o\\'reilly");
  });

  it("lists a folder and optional name filter", () => {
    assert.equal(
      buildDriveListQuery("root"),
      "'root' in parents and trashed = false",
    );
    assert.equal(
      buildDriveListQuery("root", "売上"),
      "'root' in parents and trashed = false and name contains '売上'",
    );
  });

  it("searches name and fullText inside the folder set", () => {
    assert.equal(
      buildDriveSearchQuery("渋谷 2026", ["f1", "f2"]),
      "(name contains '渋谷' or fullText contains '渋谷') and " +
        "(name contains '2026' or fullText contains '2026') and " +
        "trashed = false and ('f1' in parents or 'f2' in parents)",
    );
  });

  it("rejects an empty search", () => {
    assert.throws(() => buildDriveSearchQuery("   ", ["f1"]), /empty/);
  });
});

describe("folder helpers", () => {
  it("chunks folder ids", () => {
    assert.deepEqual(chunkIds(["a", "b", "c", "d"], 2), [["a", "b"], ["c", "d"]]);
  });
});

describe("driveFolderUrl", () => {
  it("builds the canonical folder URL", () => {
    assert.equal(driveFolderUrl("abc"), "https://drive.google.com/drive/folders/abc");
  });
});
