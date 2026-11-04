(function () {
  function accountIdentity(ctx, account) {
    const id = [account.id, account.Id, account.ID, account.user_id, account.userId, account.UserID]
      .find((value) => typeof value === "string" && value.trim())
    if (!id) throw "Ollama account identity is unavailable. Try again without changing the saved connection."
    const display = (values) => values.find((value) => typeof value === "string" && value.trim() && value.length <= 256)?.trim()
    return {
      fingerprint: ctx.host.crypto.sha256Hex(JSON.stringify(["ollama-user", id.trim()])),
      name: display([account.name, account.Name, account.username, account.Username]),
      email: display([account.email, account.Email]),
    }
  }

  globalThis.__openusage_ollama_account_identity = accountIdentity
  globalThis.__openusage_ollama_account = function (ctx) {
    const api = globalThis.__openusage_ollama_api, key = api.key(ctx), deadline = Date.now() + 25000
    try {
      const before = accountIdentity(ctx, api.request(ctx, key, "/api/me", "POST", deadline))
      const expected = ctx.host.config.get("managedAccountFingerprint")
      if (expected && before.fingerprint !== expected) throw api.failure("identityChanged", "Ollama account changed. The previous connection was kept.")
      const balance = api.request(ctx, key, "/api/balance", "GET", deadline)
      const account = api.request(ctx, key, "/api/me", "POST", deadline)
      const after = accountIdentity(ctx, account)
      if (before.fingerprint !== after.fingerprint) throw api.failure("identityChanged", "Ollama account changed. The previous connection was kept.")
      return { identity: after, ...api.quota(ctx, balance, account) }
    } catch (error) {
      ctx.host.log.error("Ollama managed account could not be verified safely")
      throw JSON.stringify({ code: typeof error === "object" && error.status || "error", message: typeof error === "string" ? error : error.message || "Could not load this Ollama account. Try again." })
    }
  }
})()
