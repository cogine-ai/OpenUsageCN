import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon"
import { MenubarIconStylePreview } from "@/components/menubar-icon-style-preview"

const preview: TraySettingsPreview = {
  bars: [{ id: "a", fraction: 0.5 }],
  providerBars: [{ id: "a", fraction: 0.75 }],
  providerIconUrl: "data:image/svg+xml;base64,abc",
  providerPercentText: "75%",
}

afterEach(() => {
  cleanup()
})

describe("MenubarIconStylePreview", () => {
  it("provider style shows percent text", () => {
    render(
      <MenubarIconStylePreview
        style="provider"
        isActive={false}
        traySettingsPreview={preview}
      />
    )

    expect(screen.getByText("75%")).toBeInTheDocument()
  })

  it("bars style renders one track per preview bar", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="bars"
        isActive={false}
        traySettingsPreview={preview}
      />
    )

    expect(container.querySelectorAll(".relative.h-1").length).toBe(1)
  })

  it("bars style falls back to three default bars when preview bars are empty", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="bars"
        isActive={false}
        traySettingsPreview={{ ...preview, bars: [] }}
      />
    )

    expect(container.querySelectorAll(".relative.h-1").length).toBe(3)
  })

  it("donut style omits progress arc when fraction is zero", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="donut"
        isActive={false}
        traySettingsPreview={{
          ...preview,
          providerBars: [{ id: "a", fraction: 0 }],
        }}
      />
    )

    const circles = container.querySelectorAll("circle[stroke-dasharray]")
    expect(circles.length).toBe(0)
  })

  it("donut style clamps fraction above one", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="donut"
        isActive={false}
        traySettingsPreview={{
          ...preview,
          providerBars: [{ id: "a", fraction: 1.5 }],
        }}
      />
    )

    const progress = container.querySelector("circle[stroke-dasharray]")
    expect(progress?.getAttribute("stroke-dasharray")).toBe("100 100")
  })
})
