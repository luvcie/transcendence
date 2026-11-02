import { expect, test } from "bun:test";
import { dismissSettingsOnBackdrop } from "./src/settings-dialog";

test("only a click outside the settings dialog closes it", () => {
  const dialog = new EventTarget() as HTMLDialogElement;
  dialog.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 300 } as DOMRect);
  let closes = 0;
  dismissSettingsOnBackdrop(dialog, () => { closes++; });
  function click(x: number, y: number, target?: EventTarget) {
    const event = new Event("click");
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, ...(target ? { target: { value: target } } : {}) });
    dialog.dispatchEvent(event);
  }
  click(150, 150);
  click(20, 20, new EventTarget());
  expect(closes).toBe(0);
  click(20, 20);
  expect(closes).toBe(1);
});
