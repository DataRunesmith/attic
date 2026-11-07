import test from "node:test";
import assert from "node:assert/strict";
import { showThemes } from "../public/theme-library.js";

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  addEventListener() {}
}

test("Theme library groups a large collection and refreshes its cards", () => {
  const grid = new Element("div");
  const previousDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === "theme-grid" ? grid : null),
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: text }),
  };
  try {
    const images = [
      { theme: "zeta", app: "plex", variant: "dark", dimensions: "1254x1254", url: "variant" },
      { theme: null, app: "ignored", dimensions: "512x512", url: "ignored" },
      { theme: "alpha", app: "sonarr", dimensions: "512x512", url: "alpha" },
      ...Array.from({ length: 10_000 }, (_, i) => ({
        theme: "zeta",
        app: "plex",
        dimensions: "512x512",
        url: `image-${i}`,
      })),
    ];
    showThemes(images);
    assert.equal(grid.children.length, 2);
    const [alpha, zeta] = grid.children;
    assert.equal(alpha.children[1].textContent, "Alpha");
    assert.equal(alpha.children[2].textContent, "1 appar · 1 bilder · 512 px");
    assert.equal(zeta.children[1].textContent, "Zeta");
    assert.equal(zeta.children[2].textContent, "1 appar · 10001 bilder · 512 + 1254 px");
    assert.equal(zeta.children[0].children[0].src, "image-0");
    assert.equal(images.length, 10_003);

    showThemes([]);
    assert.equal(grid.children.length, 1);
    assert.match(grid.children[0].textContent, /^Inga teman ännu\./);
  } finally {
    globalThis.document = previousDocument;
  }
});
