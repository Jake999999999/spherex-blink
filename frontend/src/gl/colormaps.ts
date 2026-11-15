// 256-entry RGBA lookup tables built from control points (perceptual maps sampled from matplotlib's
// published definitions at a few stops; good enough for display, not for colour science).

export type ColormapName = "night" | "gray" | "inverted" | "inferno" | "viridis" | "magma";
export const COLORMAPS: ColormapName[] = ["night", "gray", "inferno", "magma", "viridis", "inverted"];
export const COLORMAP_LABELS: Record<ColormapName, string> = {
  night: "Night sky",
  gray: "Grey",
  inverted: "Ink on paper",
  inferno: "Inferno",
  viridis: "Viridis",
  magma: "Magma",
};

type Stop = [number, number, number];

const STOPS: Record<ColormapName | "diverging", Stop[]> = {
  // Monotonic in lightness (black -> deep blue -> ice -> white), so brightness still reads as brightness.
  night: [
    [2, 4, 10], [10, 22, 48], [24, 52, 98], [46, 96, 150], [92, 154, 200], [170, 212, 236], [255, 255, 255],
  ],
  gray: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  inverted: [
    [255, 255, 255],
    [0, 0, 0],
  ],
  inferno: [
    [0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85],
    [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164],
  ],
  viridis: [
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
  ],
  magma: [
    [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
    [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
  ],
  // Difference images: cyan (fainter in the later frame) - black - amber (brighter in the later frame).
  diverging: [
    [165, 243, 252], [34, 211, 238], [8, 89, 120], [6, 10, 16], [124, 66, 6], [245, 158, 11], [254, 230, 138],
  ],
};

export function buildLut(name: ColormapName | "diverging"): Uint8Array {
  const stops = STOPS[name];
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
