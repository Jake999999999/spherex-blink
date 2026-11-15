import { expect, test } from "bun:test";
import { memFetch, putMemBundle, readBundleFiles } from "../src/lib/browser/fieldbuild";
import { loadBundle } from "../src/lib/bundle";

test("a shared field (the files of a bundle folder) opens, labelled as unverified", async () => {
  const dir = `${import.meta.dir}/../public/benchmarks/wise-0855`;
  const names = ["meta.json", "frames.bin", "gaia.json", "spectra.json", "cube.bin", "finecube.bin", "flags.bin", "neowise.bin"];
  const files: File[] = [];
  for (const n of names) {
    const f = Bun.file(`${dir}/${n}`);
    if (await f.exists()) files.push(new File([await f.arrayBuffer()], n));
  }
  files.push(new File(["<script>"], "evil.html"));
  const r = await readBundleFiles(files);
  if (typeof r === "string") throw new Error(r);
  expect(Object.keys(r.files)).not.toContain("evil.html");
  expect(r.name).toBe("WISE 0855−0714");
  putMemBundle("f-test", r.files);
  const b = await loadBundle("f-test", memFetch, "mem:f-test");
  expect(b.meta.epochs.length).toBe(3);
  expect(b.meta.tagline).toContain("not checked");
  expect(b.meta.provenance.label).toContain("unverified");
  expect(b.spectra?.sources.length).toBeGreaterThan(0);
  expect(b.neowise).not.toBeNull();
  expect(await readBundleFiles([new File(["{}"], "frames.bin")])).toContain("meta.json");
  expect(await readBundleFiles([new File(["{}"], "meta.json"), new File([""], "frames.bin")])).toContain("doesn't look like");
});
