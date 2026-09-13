import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next/font is a build-time macro; stub it for rendering the layout here.
vi.mock("next/font/google", () => ({
  Newsreader: () => ({ variable: "--font-display" }),
  Inter: () => ({ variable: "--font-sans" }),
  JetBrains_Mono: () => ({ variable: "--font-mono" }),
}));

import RootLayout from "@/app/layout";

const X_URL = "https://x.com/CRYPTFRANI";

function renderLayout() {
  // RootLayout wraps children in html/body — render the whole tree.
  return renderToStaticMarkup(
    createElement(RootLayout, { children: createElement("div", null, "x") })
  );
}

describe("site chrome", () => {
  it("carries the required footer lines on every page", () => {
    const html = renderLayout();
    expect(html).toContain("Public chain data only");
    expect(html).toContain("not financial advice");
    expect(html).toContain("Built by @ckay");
    expect(html).toContain(`href="${X_URL}"`);
    expect(html).toContain(X_URL);
  });

  it("shows the Gridscore name in the header", () => {
    const html = renderLayout();
    expect(html).toContain("Gridscore");
  });
});
