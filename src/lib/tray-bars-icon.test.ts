import { describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/image", () => ({
  Image: {
    new: vi.fn(async () => ({})),
  },
}))

import { getTrayIconSizePx, makeTrayBarsSvg, renderTrayBarsIcon } from "@/lib/tray-bars-icon"

describe("tray-bars-icon", () => {
  it("getTrayIconSizePx renders 18px at 1x and 36px at 2x", () => {
    expect(getTrayIconSizePx(1)).toBe(18)
    expect(getTrayIconSizePx(2)).toBe(36)
  })

  it("makeTrayBarsSvg emits one bar when bars empty", () => {
    const svg = makeTrayBarsSvg({ bars: [], sizePx: 18 })
    // Track rect count should be 1.
    expect(svg.match(/<rect /g)?.length).toBe(1)
  })

  it("makeTrayBarsSvg emits N tracks and fills only for defined fractions", () => {
    const svg = makeTrayBarsSvg({
      sizePx: 36,
      bars: [
        { id: "a", fraction: 0.5 },
        { id: "b", fraction: undefined },
        { id: "c", fraction: 0 },
      ],
    })

    // 3 tracks + 1 fill (0.5) => 4 rects total.
    expect(svg.match(/<rect /g)?.length).toBe(4)
  })

  it("renderTrayBarsIcon rasterizes SVG to an Image using canvas", async () => {
    const originalImage = window.Image
    const originalCreateElement = document.createElement.bind(document)

    // Stub Image loader to immediately fire onload once src is set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).Image = class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      decoding = "async"
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }

    // Stub canvas context
    const ctx = {
      clearRect: () => {},
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
    }

    // Patch createElement for canvas only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(document as any).createElement = (tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === "canvas") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(el as any).getContext = () => ctx
      }
      return el
    }

    try {
      const img = await renderTrayBarsIcon({
        sizePx: 18,
        bars: [{ id: "a", fraction: 0.5 }],
      })
      expect(img).toBeTruthy()
    } finally {
      window.Image = originalImage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(document as any).createElement = originalCreateElement
    }
  })
})

