import { describe, expect, test } from "bun:test";
import { attachExposureMeta, convertFlux, type Point } from "../src/lib/spectra";

describe("exposure provenance & flux units", () => {
  test("attachExposureMeta matches nearest MJD per detector", () => {
    const pts: Point[] = [
      { i: 0, mjd: 60902.86538, wl: 1.5, bw: 0.03, flux: 10, err: 0.5, flag: 0, det: 3, epoch: 0 },
    ];
    const out = attachExposureMeta(pts, [
      { collection: "spherex_dr1", obs_id: "2025W33_2C_0321_1", detector: 3, mjd: 60902.865381, url: "https://irsa.example/test.fits", used: true },
    ]);
    expect(out[0].obs_id).toBe("2025W33_2C_0321_1");
    expect(out[0].url).toBe("https://irsa.example/test.fits");
  });

  test("convertFlux handles mJy, AB mag, lambda*F_lambda, and 3-sigma upper limits", () => {
    const det = convertFlux(3.631, 0.1, 2.0, "abmag")!;
    expect(det.upperLimit).toBe(false);
    expect(det.value).toBeCloseTo(15.0, 2);

    const ul = convertFlux(0.1, 0.2, 2.0, "mjy")!;
    expect(ul.upperLimit).toBe(true);
    expect(ul.value).toBeCloseTo(0.7, 6);

    const sed = convertFlux(10, 0.5, 3.0, "nufnu")!;
    expect(sed.upperLimit).toBe(false);
    expect(sed.value).toBeCloseTo(0.9993, 3);
  });
});
