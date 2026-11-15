import { expect, test } from "bun:test";
import { looksLikeCoords, parseCoords } from "../src/lib/coords";

test("WISE 0855 as the challenge writes it, and other common forms", () => {
  const want = { ra: 133.795129, dec: -7.245147 };
  for (const s of ["08h55m10.831s -07d14m42.53s", "08:55:10.831 -07:14:42.53", "08 55 10.831 -07 14 42.53", "133.795129 -7.245147", "133.795129, -7.245147"]) {
    const p = parseCoords(s);
    expect(p).not.toBeNull();
    expect(p!.ra).toBeCloseTo(want.ra, 5);
    expect(p!.dec).toBeCloseTo(want.dec, 5);
  }
});

test("negative zero degrees and positive declinations", () => {
  expect(parseCoords("12:00:00 -00:30:00")!.dec).toBeCloseTo(-0.5, 9);
  expect(parseCoords("17:57:48.5 +04:41:36")!.dec).toBeCloseTo(4.693333, 5);
});

test("rejects nonsense and out-of-range values", () => {
  for (const s of ["", "R Draconis", "10 95", "abc def", "1 2 3"]) expect(parseCoords(s)).toBeNull();
  expect(parseCoords("370 10")!.ra).toBeCloseTo(10, 9);
});

test("names vs coordinates", () => {
  expect(looksLikeCoords("08:55:10 -07:14:42")).toBe(true);
  expect(looksLikeCoords("R Draconis")).toBe(false);
  expect(looksLikeCoords("Barnard's Star")).toBe(false);
});
