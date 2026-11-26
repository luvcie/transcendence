import { expect, test } from "bun:test";
import { dismissSettingsOnBackdrop } from "./src/settings-dialog";

test("settings closes for a primary backdrop click or tap that starts and ends outside", () => {
  const dialog = new EventTarget() as HTMLDialogElement;
  dialog.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 300 } as DOMRect);
  let closes = 0;
  dismissSettingsOnBackdrop(dialog, () => { closes++; });
  const content = new EventTarget();
  function send(type: string, x: number, y: number, target = dialog as EventTarget, button = 0) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: x, clientY: y, isPrimary: true, button, detail: 1,
      touches: [], changedTouches: [{ clientX: x, clientY: y }],
    });
    Object.defineProperty(event, "target", { value: target });
    dialog.dispatchEvent(event);
    return event;
  }
  send("pointerdown", 150, 150, content);
  send("click", 20, 20);
  send("pointerdown", 150, 150); // dialog padding
  send("click", 20, 20);
  send("pointerdown", 20, 20);
  send("click", 150, 150);
  send("pointerdown", 20, 20);
  send("pointercancel", 20, 20);
  send("click", 20, 20);
  send("pointerdown", 20, 20, dialog, 2);
  send("click", 20, 20);
  expect(closes).toBe(0);
  send("pointerdown", 20, 20);
  send("click", 20, 20);
  expect(closes).toBe(1);
  send("pointerdown", 150, 150, content);
  expect(send("touchend", 20, 20).defaultPrevented).toBe(false);
  expect(closes).toBe(1);
  send("pointerdown", 20, 20);
  expect(send("touchend", 20, 20).defaultPrevented).toBe(true);
  expect(closes).toBe(2);
});
