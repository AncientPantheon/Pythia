/**
 * A minimal DOM seam for testing the landing render functions in the node env
 * without pulling jsdom as a dependency. It implements only the surface the
 * render functions use: createElement, appendChild, textContent, setAttribute,
 * dataset, and querySelectorAll by tag or `[data-*]`. Not a spec-complete DOM —
 * just enough to assert what the render functions paint.
 *
 * This is a test-support module (imported only by *.test.ts). It is DOM-free
 * plain data structures, so it does not affect the runtime landing bundle.
 */
export interface FakeElement {
  tagName: string;
  children: FakeElement[];
  attributes: Record<string, string>;
  dataset: Record<string, string>;
  textContent: string;
  appendChild(child: FakeElement): FakeElement;
  setAttribute(name: string, value: string): void;
  querySelectorAll(selector: string): FakeElement[];
}

export interface FakeDocument {
  createElement(tag: string): FakeElement;
}

function matches(el: FakeElement, selector: string): boolean {
  const dataAttr = selector.match(/^\[data-([\w-]+)\]$/);
  if (dataAttr) {
    const key = dataAttr[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return key in el.dataset;
  }
  return el.tagName === selector.toLowerCase();
}

function walk(el: FakeElement, selector: string, acc: FakeElement[]): void {
  for (const child of el.children) {
    if (matches(child, selector)) acc.push(child);
    walk(child, selector, acc);
  }
}

function createElement(tag: string): FakeElement {
  const el: FakeElement = {
    tagName: tag.toLowerCase(),
    children: [],
    attributes: {},
    dataset: {},
    textContent: "",
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelectorAll(selector) {
      const acc: FakeElement[] = [];
      walk(this, selector, acc);
      return acc;
    },
  };

  // textContent aggregates own + descendant text, mirroring the DOM getter so
  // label assertions can read the whole subtree.
  Object.defineProperty(el, "textContent", {
    get(): string {
      const ownAndChildren = this.children.map(
        (c: FakeElement) => c.textContent,
      );
      return [this._ownText ?? "", ...ownAndChildren].join("");
    },
    set(value: string) {
      // Setting textContent clears children (DOM semantics) and sets own text.
      this.children = [];
      this._ownText = value;
    },
    configurable: true,
  });

  return el;
}

export function makeFakeDocument(): FakeDocument {
  return { createElement };
}
