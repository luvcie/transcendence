export class Element extends EventTarget {
  textContent = "";
  innerHTML = "";
  value: string | number = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  width = 300;
  height = 600;
  children: Element[] = [];
  parentElement?: Element;
  nodes = new Map<string, Element>();
  attributes = new Map<string, string>();
  className = "";
  classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
  calls: string[] = [];
  images: unknown[] = [];
  tiles: { color: string; x: number; y: number }[] = [];
  elements = { namedItem: (name: string) => this.querySelector(name) };
  context = {
    canvas: this, fillStyle: "", clearRect: () => { this.calls.push("clear"); },
    fillRect: (x: number, y: number) => { this.calls.push("tile"); this.tiles.push({ color: this.context.fillStyle, x, y }); },
    fillText: (text: string) => { this.calls.push(text); }, drawImage: (image: unknown) => { this.images.push(image); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {},
  };
  constructor(readonly ownerDocument: FakeDocument) { super(); }
  querySelector(selector: string): Element {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element(this.ownerDocument));
    return this.nodes.get(selector)!;
  }
  append(...children: Element[]) { children.forEach(child => { child.remove(); child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.ownerDocument.focused = this; }
  getBoundingClientRect() { return { width: this.width }; }
  getContext() { return this.context; }
}
export class FakeDocument {
  location = new URL("http://localhost:5173/");
  root = new Element(this);
  focused?: Element;
  createElement() { return new Element(this); }
  querySelector(selector: string): Element {
    if (selector === "dialog[open]") return [...this.root.nodes.values()].find(node => node.open) ?? null as unknown as Element;
    return this.root.querySelector(selector);
  }
}
