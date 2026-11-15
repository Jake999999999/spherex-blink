import { describe, expect, test } from "bun:test";
import { buildXmlRpcCall, parseXmlRpcStruct, sendViaSamp } from "../src/lib/samp";

describe("Web SAMP client", () => {
  test("encodes XML-RPC calls and escapes XML characters", () => {
    const xml = buildXmlRpcCall("samp.hub.notifyAll", ["k&1", { "samp.mtype": "image.load.fits", "samp.params": { url: "http://127.0.0.1:8091/a<b.fits" } }]);
    expect(xml).toContain("<methodName>samp.hub.notifyAll</methodName>");
    expect(xml).toContain("k&amp;1");
    expect(xml).toContain("a&lt;b.fits");
  });

  test("parses XML-RPC struct and throws on fault", () => {
    const parsed = parseXmlRpcStruct("<methodResponse><params><param><value><struct><member><name>samp.private-key</name><value><string>abc</string></value></member></struct></value></param></params></methodResponse>");
    expect(parsed["samp.private-key"]).toBe("abc");
    expect(() => parseXmlRpcStruct("<methodResponse><fault><value><struct><member><name>faultString</name><value><string>denied</string></value></member></struct></value></fault></methodResponse>")).toThrow("denied");
  });

  test("stages file on /api/samp then registers, notifies, and unregisters", async () => {
    const calls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/samp") {
        return new Response(JSON.stringify({ url: "http://127.0.0.1:8091/api/samp/0123456789abcdef/test.fits" }), { status: 200 });
      }
      const body = String(init?.body ?? "");
      if (body.includes("samp.hub.register")) {
        return new Response("<struct><member><name>samp.private-key</name><value><string>k123</string></value></member></struct>", { status: 200 });
      }
      return new Response("<struct></struct>", { status: 200 });
    }) as typeof fetch;

    await sendViaSamp({ filename: "test.fits", data: new Uint8Array([1, 2, 3]), contentType: "application/fits", mtype: "image.load.fits" }, mockFetch);
    expect(calls[0]).toBe("/api/samp");
    expect(calls.slice(1)).toEqual(["http://127.0.0.1:21012/", "http://127.0.0.1:21012/", "http://127.0.0.1:21012/", "http://127.0.0.1:21012/"]);
  });
});
