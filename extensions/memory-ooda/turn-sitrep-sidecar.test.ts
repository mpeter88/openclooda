import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearTurnSitrep,
  readTurnSitrep,
  turnSitrepPath,
  writeTurnSitrep,
} from "./emotional-tagging.js";

describe("turn-sitrep sidecar", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-sitrep-sidecar-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("write then read round-trips", () => {
    writeTurnSitrep(tmp, {
      priority: 8,
      rawPriority: 6,
      writtenAt: new Date().toISOString(),
      sessionKey: "agent:main:test",
    });
    const read = readTurnSitrep(tmp);
    expect(read).toBeDefined();
    expect(read!.priority).toBe(8);
    expect(read!.rawPriority).toBe(6);
    expect(read!.sessionKey).toBe("agent:main:test");
  });

  it("returns undefined when file missing", () => {
    expect(readTurnSitrep(tmp)).toBeUndefined();
  });

  it("returns undefined when sidecar is stale past default TTL (5 min)", () => {
    writeTurnSitrep(tmp, {
      priority: 9,
      writtenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    expect(readTurnSitrep(tmp)).toBeUndefined();
  });

  it("custom maxAgeMs overrides default", () => {
    writeTurnSitrep(tmp, {
      priority: 9,
      writtenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const read = readTurnSitrep(tmp, { maxAgeMs: 15 * 60 * 1000 });
    expect(read).toBeDefined();
  });

  it("returns undefined on malformed json", () => {
    fs.writeFileSync(turnSitrepPath(tmp), "{{not json");
    expect(readTurnSitrep(tmp)).toBeUndefined();
  });

  it("returns undefined when priority missing from payload", () => {
    fs.writeFileSync(turnSitrepPath(tmp), JSON.stringify({ writtenAt: new Date().toISOString() }));
    expect(readTurnSitrep(tmp)).toBeUndefined();
  });

  it("clear removes the sidecar file", () => {
    writeTurnSitrep(tmp, { priority: 7, writtenAt: new Date().toISOString() });
    expect(fs.existsSync(turnSitrepPath(tmp))).toBe(true);
    clearTurnSitrep(tmp);
    expect(fs.existsSync(turnSitrepPath(tmp))).toBe(false);
  });

  it("clear is a no-op when file missing", () => {
    expect(() => clearTurnSitrep(tmp)).not.toThrow();
  });
});
