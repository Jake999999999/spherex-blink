import { describe, expect, test } from "bun:test";
import { parseTargetList } from "../src/lib/targetlist";

describe("parseTargetList", () => {
  test("parses headered CSV with name,ra,dec, ra,dec, and names", () => {
    const csv = [
      "# candidate list",
      "name,ra,dec",
      "WISE 0855, 133.795, -7.245",
      "269.448, 4.739",
      "R Draconis",
    ].join("\n");
    const items = parseTargetList(csv);
    expect(items).toEqual([
      { label: "WISE 0855", query: "133.79500 -7.24500" },
      { label: "269.448, 4.739", query: "269.44800 4.73900" },
      { label: "R Draconis", query: "R Draconis" },
    ]);
  });
});
