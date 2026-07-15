import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { MenubarIconStylePreview } from "@/components/menubar-icon-style-preview"
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon"

const basePreview: TraySettingsPreview = {
  bars: [
    { id: "a", fraction: 0.5 },
    { id: "b", fraction: 0.75 },
    { id: "c", fraction: 0.25 },
  ],
  providerBars: [{ id: "codex", fraction: 0.6 }],
  providerIconUrl: "asset://codex.svg",
  providerPercentText: "60%",
}

describe("MenubarIconStylePreview", () => {
  it("renders provider style with percent text", () => {
    render(
      <MenubarIconStylePreview
        style="provider"
        isActive={false}
        traySettingsPreview={basePreview}
      />
    )
    expect(screen.getByText("60%")).toBeInTheDocument()
  })

  it("renders bars style from preview fractions", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="bars"
        isActive
        traySettingsPreview={basePreview}
      />
    )
    const tracks = container.querySelectorAll(".h-1.rounded-sm")
    expect(tracks).toHaveLength(3)
  })

  it("renders default bar fractions when preview bars are empty", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="bars"
        isActive={false}
        traySettingsPreview={{ ...basePreview, bars: [] }}
      />
    )
    const tracks = container.querySelectorAll(".h-1.rounded-sm")
    expect(tracks).toHaveLength(3)
  })

  it("renders donut style and clamps fraction to 0..1", () => {
    const { container, rerender } = render(
      <MenubarIconStylePreview
        style="donut"
        isActive
        traySettingsPreview={{
          ...basePreview,
          providerBars: [{ id: "codex", fraction: 1.5 }],
        }}
      />
    )
    let arc = container.querySelector("circle[stroke-dasharray]")
    expect(arc).toHaveAttribute("stroke-dasharray", "100 100")

    rerender(
      <MenubarIconStylePreview
        style="donut"
        isActive
        traySettingsPreview={{
          ...basePreview,
          providerBars: [{ id: "codex", fraction: -0.2 }],
        }}
      />
    )
    arc = container.querySelector("circle[stroke-dasharray]")
    expect(arc).toBeNull()
  })

  it("returns null for unknown style", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style={"unknown" as "provider"}
        isActive={false}
        traySettingsPreview={basePreview}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
