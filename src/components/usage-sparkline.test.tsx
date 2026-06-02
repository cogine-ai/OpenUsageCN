import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import userEvent from "@testing-library/user-event"
import { UsageSparkline } from "@/components/usage-sparkline"

const POINTS = [
  { label: "5/16", value: 100, valueLabel: "100 tokens" },
  { label: "5/17", value: 500, valueLabel: "500 tokens" }, // peak
  { label: "6/2", value: 50, valueLabel: "50 tokens" }, // latest
]

describe("UsageSparkline", () => {
  it("renders an inline row with an accessible summary", () => {
    render(<UsageSparkline label="Usage Trend" points={POINTS} note="Estimated from local logs" />)
    const sparkline = screen.getByRole("img", { name: /Usage Trend/ })
    expect(sparkline).toHaveAccessibleName(/latest 50 tokens on 6\/2/)
    expect(sparkline).toHaveAccessibleName(/peak 500 tokens/)
    expect(sparkline).toHaveAccessibleName(/Estimated from local logs/)
  })

  it("reveals the detail graph on hover and shows a day's usage when hovering its bar", async () => {
    const user = userEvent.setup()
    render(<UsageSparkline label="Usage Trend" points={POINTS} note="Estimated from local logs" />)

    // Hovering the row opens the larger graph; default readout is the peak.
    await user.hover(screen.getByRole("img", { name: /Usage Trend/ }))
    expect(await screen.findByText("peak 500 tokens")).toBeInTheDocument()

    // The hoverable popup stays open; hovering a day's column shows that day.
    // (fireEvent drives the handler directly — userEvent blocks on the
    // positioner's pointer-events:none, a jsdom artifact since Tailwind
    // classes aren't applied in the test DOM.)
    fireEvent.mouseEnter(screen.getByTitle("5/16: 100 tokens"))
    expect(await screen.findByText("5/16 · 100 tokens")).toBeInTheDocument()
  })

  it("returns nothing when there are no valid points", () => {
    const { container } = render(<UsageSparkline label="Usage Trend" points={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
