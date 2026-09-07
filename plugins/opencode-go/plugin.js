(function () {
  const PROVIDER_ID = "opencode-go";
  const AUTH_PATH = "~/.local/share/opencode/auth.json";
  const DB_PATH = "~/.local/share/opencode/opencode.db";
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function loadAuthFromFile(ctx) {
    if (!ctx.host.fs.exists(AUTH_PATH)) return null;
    let text;
    try {
      text = ctx.host.fs.readText(AUTH_PATH);
    } catch (_) {
      ctx.host.log.error("OpenCode Go auth.json could not be read.");
      throw "OpenCode Go credentials could not be read. Check OpenCode's local files and try again.";
    }
    const parsed = ctx.util.tryParseJson(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.host.log.error("OpenCode Go auth.json is invalid.");
      throw "OpenCode Go credentials are invalid. Log in with OpenCode Go again.";
    }
    const entry = parsed[PROVIDER_ID];
    if (entry === undefined) return null;
    if (!entry || entry.type !== "api" || typeof entry.key !== "string" || !/^\S+$/.test(entry.key.trim())) {
      ctx.host.log.error("OpenCode Go auth.json contains invalid Go credentials.");
      throw "OpenCode Go credentials are invalid. Log in with OpenCode Go again.";
    }
    return entry.key.trim();
  }

  function credentialRows(ctx, sql) {
    let raw;
    try {
      raw = ctx.host.sqlite.query(DB_PATH, sql);
    } catch (_) {
      ctx.host.log.error("OpenCode Go credential database could not be read.");
      throw "OpenCode Go credentials could not be read. Check OpenCode's local files and try again.";
    }
    // sqlite3 -json returns empty stdout for a successful SELECT with no rows.
    if (raw.trim() === "") return [];
    const rows = ctx.util.tryParseJson(raw);
    if (!Array.isArray(rows)) {
      ctx.host.log.error("OpenCode Go credential database returned invalid rows.");
      throw "OpenCode Go credentials could not be read. Check OpenCode's local files and try again.";
    }
    return rows;
  }

  function loadAuthFromDatabase(ctx) {
    if (!ctx.host.fs.exists(DB_PATH)) return null;
    const tables = credentialRows(ctx,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'");
    if (!tables.length) return null;
    const rows = credentialRows(ctx,
      "SELECT value FROM credential WHERE integration_id = 'opencode-go' LIMIT 1");
    if (!rows.length) return null;
    const value = ctx.util.tryParseJson(rows[0] && rows[0].value);
    if (!value || value.type !== "key" || typeof value.key !== "string" || !/^\S+$/.test(value.key.trim())) {
      ctx.host.log.error("OpenCode Go credential database contains invalid Go credentials.");
      throw "OpenCode Go credentials are invalid. Log in with OpenCode Go again.";
    }
    return value.key.trim();
  }

  function probe(ctx) {
    const authKey = loadAuthFromFile(ctx) || loadAuthFromDatabase(ctx);
    if (!authKey) {
      ctx.host.log.error("OpenCode Go credentials were not found.");
      throw "OpenCode Go not detected. Log in with OpenCode Go first.";
    }
    let response;
    try {
      response = ctx.host.http.request({
        method: "GET",
        url: "https://opencode.ai/zen/go/v1/usage",
        headers: { Authorization: "Bearer " + authKey, Accept: "application/json" },
        timeoutMs: 15000,
      });
    } catch (_) {
      ctx.host.log.error("OpenCode Go usage request did not complete.");
      throw "OpenCode Go usage request failed. Check your connection or proxy settings.";
    }
    const body = ctx.util.tryParseJson(response.bodyText);
    if (response.status !== 200) {
      ctx.host.log.error("OpenCode Go usage request failed (HTTP " + response.status + ").");
      if (response.status === 401) {
        throw "OpenCode Go key was rejected. Log in with OpenCode Go again.";
      }
      if (response.status === 403) {
        if (body && body.error && body.error.type === "EntitlementError") {
          throw "No OpenCode Go subscription on this key. Check your subscription in OpenCode.";
        }
        throw "OpenCode Go access was denied (HTTP 403). Check your key and account permissions.";
      }
      if (response.status === 429) {
        throw "OpenCode Go is limiting requests. Try again later.";
      }
      throw "OpenCode Go usage request failed (HTTP " + response.status + "). Try again later.";
    }
    const usage = body && body.usage;
    if (!usage || !usage.rolling || !usage.weekly || !usage.monthly) {
      ctx.host.log.error("OpenCode Go usage response is invalid.");
      throw "OpenCode Go usage response is invalid. Try again later.";
    }
    for (const window of [usage.rolling, usage.weekly, usage.monthly]) {
      if (typeof window.percent !== "number" || !Number.isFinite(window.percent)
          || window.percent < 0 || window.percent > 100
          || typeof window.resetsAt !== "string"
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(window.resetsAt)
          || !Number.isFinite(Date.parse(window.resetsAt))) {
        ctx.host.log.error("OpenCode Go usage response is invalid.");
        throw "OpenCode Go usage response is invalid. Try again later.";
      }
    }
    return {
      plan: "Go",
      lines: [
        ["Session", usage.rolling, FIVE_HOURS_MS],
        ["Weekly", usage.weekly, WEEK_MS],
        ["Monthly", usage.monthly],
      ].map(([label, window, periodDurationMs]) => ctx.line.progress({
        label,
        used: window.percent,
        limit: 100,
        format: { kind: "percent" },
        resetsAt: window.resetsAt,
        periodDurationMs,
      })),
    };
  }

  globalThis.__openusage_plugin = { id: PROVIDER_ID, probe };
})();
