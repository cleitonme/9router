import { describe, expect, it } from "vitest";

import { parseFreeEndpointHrefs } from "../../src/lib/services/catalogFreeEndpoints.js";
import { normalizeModelKey } from "../../open-sse/config/catalogConfig.js";

const CARD = (badge, hrefs) => `
  <div class="nv-card-content">
    <span>${badge}</span>
    ${hrefs.map((href) => `<a href="${href}">link</a>`).join("")}
  </div>`;

describe("parseFreeEndpointHrefs", () => {
  it("keeps only cards carrying the Free Endpoint badge", () => {
    const html = [
      CARD("Free Endpoint", ["/deepseek-ai", "/deepseek-ai/deepseek-v4.1-flash"]),
      CARD("Partner Endpoint", ["/moonshotai/kimi-k3"]),
    ].join("");
    expect(parseFreeEndpointHrefs(html)).toEqual(["deepseek-ai/deepseek-v4.1-flash"]);
  });

  it("ignores publisher links, assets and duplicates", () => {
    const html = [
      CARD("Free Endpoint", [
        "/z-ai",
        "/z-ai/glm-5-3-flash",
        "/z-ai/glm-5-3-flash",
        "/assets/marketing-icons/2.4.2/nim.svg#nim",
      ]),
    ].join("");
    expect(parseFreeEndpointHrefs(html)).toEqual(["z-ai/glm-5-3-flash"]);
  });

  it("returns an empty list for junk input", () => {
    expect(parseFreeEndpointHrefs(null)).toEqual([]);
    expect(parseFreeEndpointHrefs("<div>nothing</div>")).toEqual([]);
  });
});

describe("normalizeModelKey", () => {
  it("bridges build slugs and API ids that differ only by separators", () => {
    expect(normalizeModelKey("z-ai/glm-5-3-flash"))
      .toBe(normalizeModelKey("z-ai/glm-5.3-flash"));
    expect(normalizeModelKey("nvidia/nemotron-3_5-embed-1b"))
      .toBe(normalizeModelKey("nvidia/nemotron-3.5-embed-1b"));
  });

  it("is empty for empty input", () => {
    expect(normalizeModelKey(null)).toBe("");
  });
});
