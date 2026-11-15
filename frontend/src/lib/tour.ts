// Guided tour: each step spotlights one part of the UI, asks the visitor to try one thing, and explains
// what they just saw. Steps are data; App applies `setup` and evaluates `done` against live state.
import type { ViewState } from "./urlState";

export interface TourContext {
  target: string;
  mode: ViewState["mode"];
  band: number;
  frameKind: "wise" | "spherex" | null;
  playing: boolean;
  selectedId: string | null;
  tab: "spectrum" | "lightcurve" | "table";
}

export interface TourSetup {
  target?: string;
  patch?: Partial<ViewState>;
  select?: string | null;
  tab?: TourContext["tab"];
  playing?: boolean;
  /** jump the blink to this frame kind */
  frame?: "first-spherex" | "wise";
}

export interface TourStep {
  id: string;
  /** data-tour anchor to spotlight; none = centred card */
  anchor?: string;
  title: string;
  body: string;
  /** the one thing to try in this step */
  task?: string;
  /** shown once the task is done */
  done?: (c: TourContext) => boolean;
  doneText?: string;
  setup?: TourSetup;
  /** step only makes sense if this target is baked */
  needs?: string;
}

export const TOUR: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to SPHEREx Blink",
    body:
      "NASA's SPHEREx telescope photographs the entire sky in infrared light, once every six months. Comparing those photos shows what moved or changed. This tour takes about two minutes.",
    setup: { target: "barnard", patch: { mode: "blink", band: 6, wise: true }, playing: false, select: null, frame: "first-spherex" },
    needs: "barnard",
  },
  {
    id: "sky",
    anchor: "sky",
    title: "This is a real SPHEREx photo",
    body:
      "You're looking at a patch of sky about 8 arcminutes wide (a quarter of the Moon's width). The bright star in the middle is Barnard's Star, one of our nearest neighbours, 6 light-years away. The yellow cross marks where it should be on this date.",
    needs: "barnard",
  },
  {
    id: "wise",
    anchor: "timeline",
    title: "Go back to 2010",
    body: "Each dot on the timeline is one photo. The orange dot on the left is from 2010, taken by an older NASA telescope called WISE.",
    task: "Click the orange 2010 dot.",
    done: (c) => c.target === "barnard" && c.frameKind === "wise",
    doneText: "The star was way down there in 2010. In 16 years it has crossed almost 3 arcminutes of sky, faster than any other star.",
    needs: "barnard",
  },
  {
    id: "blink",
    anchor: "play",
    title: "Blink!",
    body:
      "Flipping quickly between photos is called blinking. Anything that stays still is a distant star; anything that jumps is close or fast. This is how Pluto was discovered in 1930.",
    task: "Press play (or the space bar).",
    done: (c) => c.playing,
    doneText: "Watch the star jump between 2010 and the three SPHEREx visits. Between SPHEREx visits it moves only 1–2 pixels, so the 2010 photo makes the motion obvious.",
    needs: "barnard",
  },
  {
    id: "diff",
    anchor: "view",
    title: "Subtract two photos",
    body:
      "Now a pair of brown dwarfs: objects too small to be stars, too big to be planets. Instead of flipping, we can subtract an older photo from a newer one, so everything that didn't change disappears.",
    task: "Click “Difference”.",
    setup: { target: "eps-ind-b", patch: { mode: "blink", band: 3 }, playing: false, select: null },
    done: (c) => c.target === "eps-ind-b" && c.mode === "diff",
    doneText: "The background went dark: those stars didn't change. The brown dwarfs moved, leaving amber (where they are now) next to cyan (where they were).",
    needs: "eps-ind-b",
  },
  {
    id: "spectrum",
    anchor: "sky",
    title: "Split its light into colours",
    body:
      "SPHEREx's superpower is colour: it measures each object at 102 infrared wavelengths. That's a spectrum, and it tells you what something is made of.",
    task: "Click the amber and cyan pair in the middle.",
    done: (c) => c.selectedId === "target",
    doneText: "Opened below.",
    needs: "eps-ind-b",
  },
  {
    id: "molecules",
    anchor: "spectrum",
    title: "Read the spectrum",
    body:
      "Each dot is one SPHEREx exposure. The deep dips line up with the labels at the top: water (H₂O) and methane (CH₄) absorbing light in the brown dwarfs' cold atmospheres. A normal star doesn't show this; try clicking a different star later to compare.",
    setup: { select: "target", tab: "spectrum" },
    needs: "eps-ind-b",
  },
  {
    id: "lightcurve",
    anchor: "spectrum",
    title: "Watch a star breathe",
    body:
      "This giant star swells and shrinks over about a year. The light curve shows its brightness on every date SPHEREx looked: it dims by about a third, then brightens again. (Its centre is so bright that we measure a ring of light around it instead.)",
    setup: { target: "nep-lpv", patch: { mode: "blink", band: 6, wise: false }, select: "target", tab: "lightcurve", playing: false },
    needs: "nep-lpv",
  },
  {
    id: "explore",
    anchor: "targets",
    title: "Your turn",
    body:
      "Pick any target up here, try other wavelengths on the right, or click any star for its spectrum. “Help” lists keyboard shortcuts, and you can restart this tour from the top bar.",
  },
];

export function availableSteps(baked: string[]): TourStep[] {
  return TOUR.filter((s) => !s.needs || baked.includes(s.needs));
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where to put the callout card next to a spotlighted rect: below if it fits, else above, else
 * beside, else centred over the bottom of the viewport. Always kept on screen.
 */
export function placeCard(r: Rect | null, card: { w: number; h: number }, vw: number, vh: number, gap = 14): { left: number; top: number } {
  const clampX = (x: number) => Math.max(8, Math.min(vw - card.w - 8, x));
  const clampY = (y: number) => Math.max(8, Math.min(vh - card.h - 8, y));
  if (!r) return { left: clampX((vw - card.w) / 2), top: clampY((vh - card.h) / 2) };
  const cx = r.left + r.width / 2 - card.w / 2;
  if (r.top + r.height + gap + card.h <= vh - 8) return { left: clampX(cx), top: r.top + r.height + gap };
  if (r.top - gap - card.h >= 8) return { left: clampX(cx), top: r.top - gap - card.h };
  if (r.left + r.width + gap + card.w <= vw - 8) return { left: r.left + r.width + gap, top: clampY(r.top + r.height / 2 - card.h / 2) };
  if (r.left - gap - card.w >= 8) return { left: r.left - gap - card.w, top: clampY(r.top + r.height / 2 - card.h / 2) };
  // big anchor (e.g. the sky view): sit inside it, near the bottom
  return { left: clampX(cx), top: clampY(r.top + r.height - card.h - gap) };
}
