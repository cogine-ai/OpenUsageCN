import { describe, expect, it } from "vitest"
import type { PluginConfigField } from "@/lib/plugin-types"
import type { ProviderConfigView } from "@/lib/provider-config"
import { configDraft, effectiveSelections, visibleConfigFields } from "@/lib/provider-config-presentation"

const sourceFields: PluginConfigField[] = [
  { id: "source", type: "select", label: "Source", default: "auto", autoValue: "auto", options: [
    { value: "auto", label: "Auto" }, { value: "api-key", label: "API Key" }, { value: "manual-cookie", label: "Cookie" },
  ] },
  { id: "apiKey", type: "secret", label: "API Key", options: [], visibleWhen: { field: "source", values: ["api-key"] }, environmentVariables: ["ALIBABA_CODING_PLAN_API_KEY"] },
  { id: "cookieHeader", type: "secret", label: "Cookie", options: [], visibleWhen: { field: "source", values: ["manual-cookie"] }, environmentVariables: ["ALIBABA_CODING_PLAN_COOKIE"] },
]
const regionFields: PluginConfigField[] = [
  { id: "region", type: "select", label: "Region", default: "auto", autoValue: "auto", options: [
    { value: "auto", label: "Auto" }, { value: "international", label: "International" }, { value: "china", label: "China" },
  ], environmentVariables: ["MOONSHOT_REGION"] },
  { id: "apiKeyIntl", type: "secret", label: "International API Key", options: [], visibleWhen: { field: "region", values: ["international"] } },
  { id: "apiKeyCn", type: "secret", label: "China API Key", options: [], visibleWhen: { field: "region", values: ["china"] } },
]
const selectedFields = (fields: PluginConfigField[], view: ProviderConfigView, draft = configDraft(fields, view)) =>
  visibleConfigFields(fields, effectiveSelections(fields, draft, view)).map((field) => field.id)

describe("Provider Config Presentation", () => {
  it("keeps every field in the draft without revealing saved secret values", () => {
    const view: ProviderConfigView = { values: {
      source: { type: "select", value: "api-key" },
      apiKey: { type: "secret", configured: true, hint: "…api" },
      cookieHeader: { type: "secret", configured: true, hint: "…cookie" },
    } }
    expect(configDraft(sourceFields, view)).toEqual({ source: "api-key", apiKey: "", cookieHeader: "" })
  })

  it("does not delete hidden credentials or unsaved drafts when the visible source changes", () => {
    const view: ProviderConfigView = { values: {
      apiKey: { type: "secret", configured: true }, cookieHeader: { type: "secret", configured: true },
    } }
    const original = structuredClone(view)
    const draft = { source: "api-key", apiKey: "new-api", cookieHeader: "new-cookie" }
    expect(selectedFields(sourceFields, view, draft)).toEqual(["source", "apiKey"])
    expect(selectedFields(sourceFields, view, { ...draft, source: "manual-cookie" })).toEqual(["source", "cookieHeader"])
    expect(view).toEqual(original)
    expect(draft).toEqual({ source: "api-key", apiKey: "new-api", cookieHeader: "new-cookie" })
  })

  it.each([
    [{ apiKey: { type: "secret", configured: true }, cookieHeader: { type: "secret", configured: true } }, {}, "api-key"],
    [{ cookieHeader: { type: "secret", configured: true } }, {}, "manual-cookie"],
    [{ apiKey: { type: "secret", configured: false }, cookieHeader: { type: "secret", configured: true } }, {}, "manual-cookie"],
    [{ cookieHeader: { type: "secret", configured: true } }, { apiKey: { name: "API_KEY", configured: true } }, "api-key"],
    [{}, { cookieHeader: { name: "COOKIE", configured: true } }, "manual-cookie"],
  ] as Array<[ProviderConfigView["values"], NonNullable<ProviderConfigView["environment"]>, string]>)
  ("resolves automatic source from available credentials, prioritizing API Key (case %#)", (values, environment, expected) => {
    const view = { values, environment }
    expect(effectiveSelections(sourceFields, configDraft(sourceFields, view), view).source).toBe(expected)
  })

  it("prefers a nonblank new API credential over a saved Cookie while keeping automatic mode in the draft", () => {
    const view: ProviderConfigView = { values: { cookieHeader: { type: "secret", configured: true } } }
    const draft = { ...configDraft(sourceFields, view), apiKey: " sk-new " }
    expect(effectiveSelections(sourceFields, draft, view).source).toBe("api-key")
    expect(draft.source).toBe("auto")
  })

  it("ignores whitespace-only new API input when automatic mode has an available Cookie", () => {
    const view: ProviderConfigView = { values: { cookieHeader: { type: "secret", configured: true } } }
    const draft = { ...configDraft(sourceFields, view), apiKey: "   \t " }
    expect(effectiveSelections(sourceFields, draft, view).source).toBe("manual-cookie")
  })

  it("honors an explicit saved source before environment defaults and available API credentials", () => {
    const view: ProviderConfigView = { values: {
      source: { type: "select", value: "manual-cookie" }, apiKey: { type: "secret", configured: true },
    }, environment: { source: { name: "SOURCE", configured: true, value: "api-key" } } }
    expect(effectiveSelections(sourceFields, configDraft(sourceFields, view), view).source).toBe("manual-cookie")
  })

  it("honors a valid explicit environment source before automatic credential selection", () => {
    const view: ProviderConfigView = { values: { apiKey: { type: "secret", configured: true } },
      environment: { source: { name: "SOURCE", configured: true, value: "manual-cookie" } } }
    expect(effectiveSelections(sourceFields, configDraft(sourceFields, view), view).source).toBe("manual-cookie")
  })

  it("ignores an unsupported environment selection rather than hiding both credential inputs", () => {
    const view: ProviderConfigView = { values: { cookieHeader: { type: "secret", configured: true } },
      environment: { source: { name: "SOURCE", configured: true, value: "unsupported" } } }
    expect(selectedFields(sourceFields, view)).toEqual(["source", "cookieHeader"])
  })

  it("shows only the China credential when automatic region resolves from MOONSHOT_REGION=china", () => {
    const view: ProviderConfigView = { values: { apiKeyIntl: { type: "secret", configured: true } },
      environment: { region: { name: "MOONSHOT_REGION", configured: true, value: "china" } } }
    expect(selectedFields(regionFields, view)).toEqual(["region", "apiKeyCn"])
    expect(configDraft(regionFields, view).region).toBe("auto")
  })

  it("keeps automatic Moonshot region international when only a China credential is saved", () => {
    const view: ProviderConfigView = { values: { apiKeyCn: { type: "secret", configured: true } } }
    const draft = configDraft(regionFields, view)
    expect(effectiveSelections(regionFields, draft, view).region).toBe("international")
    expect(selectedFields(regionFields, view, draft)).toEqual(["region", "apiKeyIntl"])
    expect(draft.region).toBe("auto")
    expect(view.values.apiKeyCn).toEqual({ type: "secret", configured: true })
  })

  it("requires an explicit region selection for an invalid configured Moonshot environment region", () => {
    const view: ProviderConfigView = { values: { apiKeyCn: { type: "secret", configured: true } },
      environment: { region: { name: "MOONSHOT_REGION", configured: true, value: "unsupported" } } }
    const draft = configDraft(regionFields, view)
    expect(effectiveSelections(regionFields, draft, view).region).toBe("")
    expect(selectedFields(regionFields, view, draft)).toEqual(["region"])
    expect(selectedFields(regionFields, view, { ...draft, region: "china" })).toEqual(["region", "apiKeyCn"])
    expect(selectedFields(regionFields, view, { ...draft, region: "international" })).toEqual(["region", "apiKeyIntl"])
  })

  it("keeps an explicit international region independent of a China environment default", () => {
    const view: ProviderConfigView = { values: { region: { type: "select", value: "international" } },
      environment: { region: { name: "MOONSHOT_REGION", configured: true, value: "china" } } }
    expect(selectedFields(regionFields, view)).toEqual(["region", "apiKeyIntl"])
  })

  it("does not treat an unconfirmed automatic region as the international default", () => {
    const view: ProviderConfigView = { values: { apiKeyIntl: { type: "secret", configured: true } },
      environmentError: "无法确认环境变量配置，请检查终端设置后重试。", environmentUnresolved: ["MOONSHOT_REGION"] }
    const draft = configDraft(regionFields, view)
    expect(effectiveSelections(regionFields, draft, view).region).toBe("")
    expect(selectedFields(regionFields, view)).toEqual(["region"])
    expect(selectedFields(regionFields, view, { ...draft, region: "international" })).toEqual(["region", "apiKeyIntl"])
  })

  it("keeps a confirmed absent region default while another source is unconfirmed", () => {
    const view: ProviderConfigView = { values: {}, environmentError: "无法确认环境变量配置，请检查终端设置后重试。",
      environmentUnresolved: ["MOONSHOT_API_KEY"] }
    expect(effectiveSelections(regionFields, configDraft(regionFields, view), view).region).toBe("international")
  })
})
