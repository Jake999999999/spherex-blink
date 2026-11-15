import { describe, expect, test } from "bun:test";
import { TOUR, availableSteps, placeCard, type TourContext } from "../src/lib/tour";

const ctx = (p: Partial<TourContext>): TourContext => ({
  target: "barnard",
  mode: "blink",
  band: 6,
  frameKind: "spherex",
  playing: false,
  selectedId: null,
  tab: "spectrum",
  ...p,
});

describe("tour steps", () => {
  test("steps for missing targets are dropped, the rest keep their order", () => {
    const ids = availableSteps(["barnard"]).map((s) => s.id);
    expect(ids).toEqual(["welcome", "sky", "wise", "blink", "explore"]);
    expect(availableSteps(["barnard", "eps-ind-b", "nep-lpv"])).toHaveLength(TOUR.length);
  });
  test("every task has a check and a payoff sentence", () => {
    for (const s of TOUR) if (s.task) expect(typeof s.done === "function" && !!s.doneText).toBe(true);
  });
  test("task checks follow what the visitor did", () => {
    const by = Object.fromEntries(TOUR.map((s) => [s.id, s]));
    expect(by.wise.done!(ctx({ frameKind: "spherex" }))).toBe(false);
    expect(by.wise.done!(ctx({ frameKind: "wise" }))).toBe(true);
    expect(by.blink.done!(ctx({ playing: true }))).toBe(true);
    expect(by.diff.done!(ctx({ target: "eps-ind-b", mode: "diff" }))).toBe(true);
    expect(by.diff.done!(ctx({ target: "barnard", mode: "diff" }))).toBe(false);
    expect(by.spectrum.done!(ctx({ target: "eps-ind-b", selectedId: "target" }))).toBe(true);
  });
});

describe("placeCard", () => {
  const card = { w: 300, h: 200 };
  test("below the anchor when there is room", () => {
    expect(placeCard({ left: 100, top: 50, width: 200, height: 40 }, card, 1200, 800)).toEqual({ left: 50, top: 104 });
  });
  test("above when the anchor is at the bottom", () => {
    const p = placeCard({ left: 100, top: 700, width: 200, height: 60 }, card, 1200, 800);
    expect(p.top).toBe(700 - 14 - 200);
  });
  test("stays on screen", () => {
    const p = placeCard({ left: 1150, top: 10, width: 40, height: 20 }, card, 1200, 800);
    expect(p.left + card.w).toBeLessThanOrEqual(1192);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
  test("a huge anchor gets the card inside it, near the bottom", () => {
    const p = placeCard({ left: 0, top: 0, width: 1200, height: 800 }, card, 1200, 800);
    expect(p.top).toBe(800 - 200 - 14);
  });
  test("no anchor: centred", () => {
    expect(placeCard(null, card, 1000, 600)).toEqual({ left: 350, top: 200 });
  });
});
