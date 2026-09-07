import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx } from "../test-helpers.js";

const AUTH_PATH = "~/.local/share/opencode/auth.json";

function usageResponse() {
  return { usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-09-07T15:00:00.000Z" },
    weekly: { status: "ok", percent: 0.25, resetsAt: "2026-09-14T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-21T03:04:05.000Z" },
  } };
}

function respond(ctx, body = usageResponse()) {
  ctx.host.http.request.mockReturnValue({ status: 200, headers: {}, bodyText: JSON.stringify(body) });
}

const loadPlugin = async () => {
  await import("./plugin.js");
  return globalThis.__openusage_plugin;
};

function setAuth(ctx, value = "go-key") {
  ctx.host.fs.writeText(
    AUTH_PATH,
    JSON.stringify({
      "opencode-go": { type: "api", key: value },
    }),
  );
}

describe("opencode-go plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ships plugin metadata with links and expected line layout", () => {
    const manifest = JSON.parse(
      readFileSync("plugins/opencode-go/plugin.json", "utf8"),
    );

    expect(manifest.id).toBe("opencode-go");
    expect(manifest.name).toBe("OpenCode Go");
    expect(manifest.brandColor).toBe("#000000");
    expect(manifest.links).toEqual([
      { label: "Console", url: "https://opencode.ai/auth" },
      { label: "Docs", url: "https://opencode.ai/docs/go/" },
    ]);
    expect(manifest.lines).toEqual([
      {
        type: "progress",
        label: "Session",
        scope: "overview",
        primaryOrder: 1,
        limitResource: { key: "session" },
      },
      {
        type: "progress",
        label: "Weekly",
        scope: "overview",
        period: "weekly",
        limitResource: { key: "weekly" },
      },
      {
        type: "progress",
        label: "Monthly",
        scope: "detail",
        limitResource: { key: "monthly" },
      },
    ]);
  });

  it("shows account-wide API quotas and resets without requiring local history", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    ctx.host.sqlite.query.mockImplementation(() => {
      throw new Error("local history must not be required");
    });
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ usage: {
        rolling: { status: "ok", percent: 12.5, resetsAt: "2026-09-07T15:00:00.000Z" },
        weekly: { status: "ok", percent: 35, resetsAt: "2026-09-14T00:00:00.000Z" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-21T03:04:05.000Z" },
      } }),
    });

    const result = (await loadPlugin()).probe(ctx);

    expect(result).toEqual({ plan: "Go", lines: [
      { type: "progress", label: "Session", used: 12.5, limit: 100, format: { kind: "percent" }, resetsAt: "2026-09-07T15:00:00.000Z", periodDurationMs: 18_000_000 },
      { type: "progress", label: "Weekly", used: 35, limit: 100, format: { kind: "percent" }, resetsAt: "2026-09-14T00:00:00.000Z", periodDurationMs: 604_800_000 },
      { type: "progress", label: "Monthly", used: 100, limit: 100, format: { kind: "percent" }, resetsAt: "2026-09-21T03:04:05.000Z" },
    ] });
    expect(ctx.host.http.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://opencode.ai/zen/go/v1/usage",
      headers: { Authorization: "Bearer go-key", Accept: "application/json" },
      timeoutMs: 15000,
    });
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled();
  });

  it("reports a rejected Go key without exposing the provider's raw response", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    ctx.host.http.request.mockReturnValue({
      status: 401,
      headers: {},
      bodyText: JSON.stringify({ error: { message: "rejected go-key" } }),
    });
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go key was rejected. Log in with OpenCode Go again.");
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go usage request failed (HTTP 401).");
  });

  it.each([
    [403, { error: { type: "EntitlementError" } }, "No OpenCode Go subscription on this key. Check your subscription in OpenCode."],
    [403, { error: { type: "Forbidden" } }, "OpenCode Go access was denied (HTTP 403). Check your key and account permissions."],
    [429, {}, "OpenCode Go is limiting requests. Try again later."],
    [503, {}, "OpenCode Go usage request failed (HTTP 503). Try again later."],
  ])("reports HTTP %s as an actionable error", async (status, body, message) => {
    const ctx = makeCtx();
    setAuth(ctx);
    ctx.host.http.request.mockReturnValue({ status, headers: {}, bodyText: JSON.stringify(body) });
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow(message);
    expect(ctx.host.log.error).toHaveBeenCalledWith(`OpenCode Go usage request failed (HTTP ${status}).`);
  });

  it.each([null, {}, [], { usage: {} }, { usage: { rolling: {} } }].map(body => ({ body })))("rejects incomplete payload $body without publishing empty quotas", async ({ body }) => {
    const ctx = makeCtx();
    setAuth(ctx);
    respond(ctx, body);
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go usage response is invalid. Try again later.");
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go usage response is invalid.");
  });

  it.each([null, undefined, "0", "", true, -0.1, 100.1, Infinity, NaN])("rejects invalid quota percentage %s", async (percent) => {
    const ctx = makeCtx();
    setAuth(ctx);
    const body = usageResponse();
    body.usage.weekly.percent = percent;
    respond(ctx, body);
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go usage response is invalid. Try again later.");
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go usage response is invalid.");
  });

  it.each([null, "", "invalid", "0", "2026-09-07", 1788793200000])("rejects an invalid reset timestamp %s", async (resetsAt) => {
    const ctx = makeCtx();
    setAuth(ctx);
    const body = usageResponse();
    body.usage.monthly.resetsAt = resetsAt;
    respond(ctx, body);
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go usage response is invalid. Try again later.");
  });

  it("reads the OpenCode 2 Go credential without accepting another provider's key", async () => {
    const ctx = makeCtx();
    ctx.host.fs.writeText("~/.local/share/opencode/opencode.db", "fixture database");
    ctx.host.sqlite.query.mockImplementation((_path, sql) => {
      if (sql.includes("sqlite_master")) return JSON.stringify([{ name: "credential" }]);
      expect(sql).toContain("integration_id = 'opencode-go'");
      expect(sql).not.toMatch(/\bOR\b|\bLIKE\b/i);
      return JSON.stringify([{ value: JSON.stringify({ type: "key", key: "go-v2-key" }) }]);
    });
    respond(ctx);

    const result = (await loadPlugin()).probe(ctx);

    expect(result.lines.map(line => line.used)).toEqual([0, 0.25, 100]);
    expect(result.lines[0].resetsAt).toBe("2026-09-07T15:00:00.000Z");
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer go-v2-key");
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled();
  });

  it("does not infer an account from local history when credentials are absent", async () => {
    const ctx = makeCtx();
    ctx.host.fs.writeText("~/.local/share/opencode/opencode.db", "fixture database");
    ctx.host.sqlite.query.mockReturnValue("[]");
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go not detected. Log in with OpenCode Go first.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
    expect(ctx.host.log.error).toHaveBeenCalled();
  });

  it("surfaces unreadable credentials without logging the secret or falling back", async () => {
    const ctx = makeCtx();
    setAuth(ctx, "sensitive-key-value");
    vi.spyOn(ctx.host.fs, "readText").mockImplementation(() => {
      throw new Error("cannot read sensitive-key-value");
    });
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go credentials could not be read. Check OpenCode's local files and try again.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled();
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go auth.json could not be read.");
    expect(JSON.stringify(ctx.host.log.warn.mock.calls)).not.toContain("sensitive-key-value");
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("sensitive-key-value");
  });

  it("surfaces a malformed auth file instead of silently treating it as logout", async () => {
    const ctx = makeCtx();
    ctx.host.fs.writeText(AUTH_PATH, "not-json");
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go credentials are invalid. Log in with OpenCode Go again.");
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go auth.json is invalid.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it("reports unreadable credential storage when no auth file is available", async () => {
    const ctx = makeCtx();
    ctx.host.fs.writeText("~/.local/share/opencode/opencode.db", "fixture database");
    ctx.host.sqlite.query.mockImplementation(() => { throw new Error("database locked"); });
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go credentials could not be read. Check OpenCode's local files and try again.");
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go credential database could not be read.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it("returns a friendly network error without logging raw transport details", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    ctx.host.http.request.mockImplementation(() => { throw new Error("proxy failed for go-key"); });
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go usage request failed. Check your connection or proxy settings.");
    expect(ctx.host.log.error).toHaveBeenCalledWith("OpenCode Go usage request did not complete.");
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("go-key");
  });

  it.each(["not-json", "{}", "null"])("rejects unreadable credential rows %s without making a request", async (raw) => {
    const ctx = makeCtx();
    ctx.host.fs.writeText("~/.local/share/opencode/opencode.db", "fixture database");
    ctx.host.sqlite.query.mockReturnValue(raw);
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go credentials could not be read. Check OpenCode's local files and try again.");
    expect(ctx.host.log.error).toHaveBeenCalled();
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it.each([
    { type: "api", key: "" },
    { type: "api", key: 42 },
    { type: "api", key: "two key parts" },
    { type: "oauth", key: "not-an-api-key" },
  ])("rejects an invalid Go auth entry $type / $key", async (entry) => {
    const ctx = makeCtx();
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify({ "opencode-go": entry }));
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go credentials are invalid. Log in with OpenCode Go again.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
    expect(ctx.host.log.error).toHaveBeenCalled();
  });

  it("reports a corrupt Go credential record rather than treating it as logout", async () => {
    const ctx = makeCtx();
    ctx.host.fs.writeText("~/.local/share/opencode/opencode.db", "fixture database");
    ctx.host.sqlite.query
      .mockReturnValueOnce('[{"name":"credential"}]')
      .mockReturnValueOnce('[{"value":"not-json"}]');
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go credentials are invalid. Log in with OpenCode Go again.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
    expect(ctx.host.log.error).toHaveBeenCalled();
  });

  it.each(["", "not-json"])("rejects a successful response with an unreadable body %s", async (bodyText) => {
    const ctx = makeCtx();
    setAuth(ctx);
    ctx.host.http.request.mockReturnValue({ status: 200, headers: {}, bodyText });
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go usage response is invalid. Try again later.");
    expect(ctx.host.log.error).toHaveBeenCalled();
  });

  it("does not use unrelated credentials when the Go entry is missing", async () => {
    const ctx = makeCtx();
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify({ openai: { type: "api", key: "sk-other-provider" } }));
    ctx.host.fs.writeText("~/.local/share/opencode/opencode.db", "fixture database");
    ctx.host.sqlite.query
      .mockReturnValueOnce('[{"name":"credential"}]')
      .mockReturnValueOnce('[]');
    const plugin = await loadPlugin();

    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go not detected. Log in with OpenCode Go first.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it("reuses the Go auth file without reading or modifying SQLite credentials", async () => {
    const ctx = makeCtx();
    setAuth(ctx, "  go-key  ");
    ctx.host.fs.writeText("~/.local/share/opencode/opencode.db", "fixture database");
    respond(ctx);
    ctx.host.fs.writeText.mockClear();

    const result = (await loadPlugin()).probe(ctx);

    expect(result.lines.map(line => line.used)).toEqual([0, 0.25, 100]);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer go-key");
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled();
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled();
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled();
  });

});
