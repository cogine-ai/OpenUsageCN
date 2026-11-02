import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx } from "../test-helpers.js";

const DIRECTORY = "~/.local/share/opencode";
const row = (integration_id, value) => ({ integration_id, value: JSON.stringify(value) });

async function setup(rows, directory = DIRECTORY, filename = "opencode.db") {
  const ctx = makeCtx();
  ctx.host.fs.writeText(directory + "/auth.json", JSON.stringify({
    "opencode-go": { type: "api", key: "stale-legacy-key" },
  }));
  const db = filename.startsWith("/") ? filename : directory + "/" + filename;
  ctx.host.fs.writeText(db, "fixture");
  ctx.host.sqlite.query.mockImplementation((_path, sql) => sql.includes("sqlite_master")
    ? '[{"name":"credential"}]' : JSON.stringify(rows));
  ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ usage:
    Object.fromEntries(["rolling", "weekly", "monthly"].map(name => [name, {
      percent: 12.5, resetsAt: "2026-11-03T00:00:00Z",
    }])),
  }) });
  ctx.host.fs.writeText.mockClear();
  await import("./plugin.js");
  return { ctx, plugin: globalThis.__openusage_plugin, db };
}

describe("OpenCode Go Active Credentials", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin; });

  it.each(["opencode-go", "opencode"])("uses the active %s key instead of stale auth.json", async integration => {
    const { ctx, plugin } = await setup([row(integration, { type: "key", key: "active-key" })]);
    plugin.probe(ctx);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer active-key");
    expect(ctx.host.sqlite.query.mock.calls[1][1]).toContain("WHERE active = 1");
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled();
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled();
  });

  it("prefers Go when both integrations have active credentials", async () => {
    const { ctx, plugin } = await setup([
      row("opencode-go", { type: "key", key: "go-key" }),
      row("opencode", { type: "key", key: "other-key" }),
    ]);
    plugin.probe(ctx);
    expect(ctx.host.sqlite.query.mock.calls[1][1]).toContain("ORDER BY CASE integration_id WHEN 'opencode-go' THEN 0 ELSE 1 END LIMIT 2");
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer go-key");
  });

  it.each(["opencode-go", "opencode"])("rejects two active %s accounts without reviving legacy auth", async integration => {
    const { ctx, plugin } = await setup([
      row(integration, { type: "key", key: "first-secret" }),
      row(integration, { type: "key", key: "second-secret" }),
    ]);
    expect(() => plugin.probe(ctx)).toThrow("credentials are invalid");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("secret");
  });

  it("treats an authoritative table with no active login as logged out", async () => {
    const { ctx, plugin } = await setup([]);
    expect(() => plugin.probe(ctx)).toThrow("not detected");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it("uses an unexpired OAuth access token without renewal or writes", async () => {
    const { ctx, plugin } = await setup([row("opencode", {
      type: "oauth", access: "oauth-access", expires: Date.parse("2026-02-02T00:00:01Z"),
    })]);
    plugin.probe(ctx);
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer oauth-access");
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled();
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled();
  });

  it.each([Date.parse("2026-02-02T00:00:00Z"), 1769990400, -1, 1.5, "9999999999999", null])(
    "rejects invalid or expired OAuth expiry %s", async expires => {
      const { ctx, plugin } = await setup([row("opencode", { type: "oauth", access: "private-access", expires })]);
      expect(() => plugin.probe(ctx)).toThrow("credentials are invalid");
      expect(ctx.host.http.request).not.toHaveBeenCalled();
    },
  );

  it.each(["bad\u0000key", "bad\u007fkey", "two parts", ""])("rejects invalid selected keys %j", async key => {
    const { ctx, plugin } = await setup([row("opencode", { type: "key", key })]);
    expect(() => plugin.probe(ctx)).toThrow("credentials are invalid");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it.each([
    ["/tmp/custom-data", "preview.db", "/tmp/custom-data/opencode", "preview.db"],
    ["relative-path", "/tmp/preview.db", DIRECTORY, "/tmp/preview.db"],
  ])("resolves XDG data home %s and database %s", async (dataHome, filename, directory, dbName) => {
    const { ctx, plugin, db } = await setup([row("opencode", { type: "key", key: "custom-key" })], directory, dbName);
    ctx.host.env.get.mockImplementation(name => ({ XDG_DATA_HOME: dataHome, OPENCODE_DB: filename })[name]);
    plugin.probe(ctx);
    expect(ctx.host.sqlite.query.mock.calls.map(([path]) => path)).toEqual([db, db]);
  });

  it("does not revive legacy auth for an in-memory OpenCode database", async () => {
    const { ctx, plugin } = await setup([]);
    ctx.host.env.get.mockImplementation(name => name === "OPENCODE_DB" ? ":memory:" : null);
    expect(() => plugin.probe(ctx)).toThrow("not detected");
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled();
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "ENOTDIR"])("does not revive legacy auth after a %s database metadata error", async code => {
    const { ctx, plugin, db } = await setup([]);
    const readText = vi.spyOn(ctx.host.fs, "readText");
    ctx.host.fs.existsStrict.mockImplementation(() => {
      throw new Error(code + ": private-storage-path");
    });
    expect(() => plugin.probe(ctx)).toThrow("credentials could not be read");
    expect(ctx.host.fs.existsStrict).toHaveBeenCalledWith(db);
    expect(readText).not.toHaveBeenCalled();
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled();
    expect(ctx.host.http.request).not.toHaveBeenCalled();
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go credential database metadata could not be read.");
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private-storage-path");
  });

  it("still uses legacy auth when the modern database is confirmed missing", async () => {
    const { ctx, plugin } = await setup([]);
    ctx.host.fs.existsStrict.mockReturnValue(false);
    const readText = vi.spyOn(ctx.host.fs, "readText");
    plugin.probe(ctx);
    expect(readText).toHaveBeenCalledWith(DIRECTORY + "/auth.json");
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled();
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer stale-legacy-key");
  });

  it("does not fall back after a modern database error", async () => {
    const { ctx, plugin } = await setup([]);
    ctx.host.sqlite.query.mockImplementation(() => { throw new Error("private-storage-path"); });
    expect(() => plugin.probe(ctx)).toThrow("credentials could not be read");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private-storage-path");
  });
});
