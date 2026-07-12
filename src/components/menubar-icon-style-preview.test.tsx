import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MenubarIconStylePreview } from "@/components/menubar-icon-style-preview"
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon"

const preview: TraySettingsPreview = {
  bars: [{ id: "weekly", fraction: 0.5 }],
  providerBars: [{ id: "weekly", fraction: 0.75 }],
  providerIconUrl: "https://example.com/icon.svg",
  providerPercentText: "75%",
}

afterEach(() => {
  cleanup()
})

describe("MenubarIconStylePreview", () => {
  it("renders provider style with percent text and masked icon", () => {
    const { container } = render(
      <MenubarIconStylePreview style="provider" isActive={false} traySettingsPreview={preview} />
    )

    expect(screen.getByText("75%")).toBeInTheDocument()
    const mask = container.querySelector("[style*='mask-image']")
    expect(mask).toBeTruthy()
    expect(mask).toHaveStyle({ maskImage: "url(https://example.com/icon.svg)" })
  })

  it("renders provider fallback circle when icon url is missing", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="provider"
        isActive
        traySettingsPreview={{ ...preview, providerIconUrl: undefined }}
      />
    )

    expect(screen.getByText("75%")).toBeInTheDocument()
    expect(container.querySelector("circle")).toBeTruthy()
    expect(container.querySelector("[style*='mask-image']")).toBeNull()
  })

  it("renders bars style from preview fractions", () => {
    const { container } = render(
      <MenubarIconStylePreview style="bars" isActive={false} traySettingsPreview={preview} />
    )

    const tracks = container.querySelectorAll(".h-1.rounded-sm")
    expect(tracks).toHaveLength(1)
    const fill = container.querySelector(".h-1.rounded-sm > .h-1")
    expect(fill).toHaveStyle({ width: "50%" })
  })

  it("renders three default bars when preview bars are empty", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="bars"
        isActive={false}
        traySettingsPreview={{ ...preview, bars: [] }}
      />
    )

    const tracks = container.querySelectorAll(".h-1.rounded-sm")
    expect(tracks).toHaveLength(3)
  })

  it("renders donut style with clamped progress arc", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="donut"
        isActive
        traySettingsPreview={{
          ...preview,
          providerBars: [{ id: "weekly", fraction: 1.5 }],
        }}
      />
    )

    const progress = container.querySelector("circle[stroke-dasharray]")
    expect(progress).toHaveAttribute("stroke-dasharray", "100 100")
  })

  it("omits donut progress arc when fraction is zero", () => {
    const { container } = render(
      <MenubarIconStylePreview
        style="donut"
        isActive={false}
        traySettingsPreview={{
          ...preview,
          providerBars: [{ id: "weekly", fraction: 0 }],
        }}
      />
    )

    expect(container.querySelector("circle[stroke-dasharray]")).toBeNull()
    expect(container.querySelectorAll("circle")).toHaveLength(1)
  })
})
