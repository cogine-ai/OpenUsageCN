import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { MenubarIconStylePreview } from "@/components/menubar-icon-style-preview"
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon"

const preview: TraySettingsPreview = {
  bars: [
    { id: "session", fraction: 0.75 },
    { id: "weekly", fraction: 0.5 },
  ],
  providerBars: [{ id: "primary", fraction: 0.66 }],
  providerIconUrl: "data:image/svg+xml;base64,ICON",
  providerPercentText: "66%",
}

describe("MenubarIconStylePreview", () => {
  it("renders provider style with icon mask and percent text", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="provider"
        isActive={false}
        traySettingsPreview={preview}
      />
    )

    expect(screen.getByText("66%")).toBeInTheDocument()
    const mask = container.querySelector("[style*='mask-image']")
    expect(mask).toBeTruthy()
    expect(mask?.getAttribute("style")).toContain(preview.providerIconUrl)
  })

  it("renders bars style with default fractions when bars are empty", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="bars"
        isActive
        traySettingsPreview={{ ...preview, bars: [] }}
      />
    )

    expect(container.querySelectorAll(".h-1").length).toBeGreaterThanOrEqual(3)
  })

  it("renders bars style from preview fractions", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="bars"
        isActive={false}
        traySettingsPreview={preview}
      />
    )

    expect(container.querySelectorAll(".relative.h-1").length).toBe(2)
  })

  it("renders donut style and clamps overflow fractions", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="donut"
        isActive
        traySettingsPreview={{
          ...preview,
          providerBars: [{ id: "primary", fraction: 1.5 }],
        }}
      />
    )

    const arc = container.querySelector("circle[stroke-dasharray]")
    expect(arc).toBeTruthy()
    expect(arc?.getAttribute("stroke-dasharray")).toBe("100 100")
  })

  it("renders donut style without arc when fraction is zero", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="donut"
        isActive={false}
        traySettingsPreview={{
          ...preview,
          providerBars: [{ id: "primary", fraction: 0 }],
        }}
      />
    )

    expect(container.querySelector("circle[stroke-dasharray]")).toBeNull()
    expect(container.querySelectorAll("circle").length).toBeGreaterThanOrEqual(1)
  })
})
