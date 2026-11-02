(function () {
  const PROVIDER_ID = "opencode-go";
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function credentialPaths(ctx) {
    const dataHome = ctx.host.env.get("XDG_DATA_HOME");
    const directory = (typeof dataHome === "string" && dataHome.startsWith("/")
      ? dataHome.replace(/\/+$/, "") : "~/.local/share") + "/opencode";
    const filename = ctx.host.env.get("OPENCODE_DB") || "opencode.db";
    return {
      auth: directory + "/auth.json",
      database: filename === ":memory:" ? null
        : filename.startsWith("/") ? filename : directory + "/" + filename,
    };
  }

  function invalidCredential(ctx) {
    ctx.host.log.error("OpenCode Go credentials are invalid or ambiguous.");
    throw "OpenCode Go credentials are invalid. Log in with OpenCode Go again.";
  }

  function credentialToken(ctx, value) {
    if (typeof value !== "string" || !value.trim() || /[\s\u0000-\u001f\u007f-\u009f]/.test(value.trim())) {
      invalidCredential(ctx);
    }
    return value.trim();
  }

  function loadAuthFromFile(ctx, authPath) {
    if (!ctx.host.fs.exists(authPath)) return null;
    let text;
    try {
      text = ctx.host.fs.readText(authPath);
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
    return credentialToken(ctx, entry.key);
  }

  function credentialRows(ctx, databasePath, sql) {
    let raw;
    try {
      raw = ctx.host.sqlite.query(databasePath, sql);
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

  function loadAuth(ctx) {
    const paths = credentialPaths(ctx);
    if (paths.database === null) return null;
    let databaseExists;
    try {
      databaseExists = ctx.host.fs.existsStrict(paths.database);
    } catch (_) {
      ctx.host.log.error("OpenCode Go credential database metadata could not be read.");
      throw "OpenCode Go credentials could not be read. Check OpenCode's local files and try again.";
    }
    if (!databaseExists) return loadAuthFromFile(ctx, paths.auth);
    const tables = credentialRows(ctx, paths.database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'");
    if (!tables.length) return loadAuthFromFile(ctx, paths.auth);
    const rows = credentialRows(ctx, paths.database,
      "SELECT integration_id, value FROM credential " +
      "WHERE active = 1 AND integration_id IN ('opencode-go', 'opencode') " +
      "ORDER BY CASE integration_id WHEN 'opencode-go' THEN 0 ELSE 1 END LIMIT 2");
    if (!rows.length) return null;
    const integration = rows[0] && rows[0].integration_id;
    if (![PROVIDER_ID, "opencode"].includes(integration) ||
        (rows.length > 1 && rows[1].integration_id === integration)) invalidCredential(ctx);
    const value = ctx.util.tryParseJson(rows[0] && rows[0].value);
    if (!value || typeof value !== "object") invalidCredential(ctx);
    if (value.type === "key") return credentialToken(ctx, value.key);
    if (value.type === "oauth") {
      const now = Date.parse(ctx.nowIso);
      if (!Number.isSafeInteger(value.expires) || value.expires < 0 ||
          value.expires <= (Number.isFinite(now) ? now : Date.now())) invalidCredential(ctx);
      return credentialToken(ctx, value.access);
    }
    invalidCredential(ctx);
  }

  function probe(ctx) {
    const authKey = loadAuth(ctx);
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
