export function dismissSettingsOnBackdrop(dialog: HTMLDialogElement, close: () => void) {
  let startedOnBackdrop = false;
  function onBackdrop(target: EventTarget | null, { clientX, clientY }: Pick<MouseEvent, "clientX" | "clientY">): boolean {
    if (target !== dialog) return false;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return clientX < left || clientX > right || clientY < top || clientY > bottom;
  }
  dialog.addEventListener("pointerdown", event => {
    startedOnBackdrop = event.isPrimary && event.button === 0 && onBackdrop(event.target, event);
  });
  dialog.addEventListener("pointercancel", () => { startedOnBackdrop = false; });
  dialog.addEventListener("click", event => {
    const dismiss = startedOnBackdrop && event.detail > 0 && onBackdrop(event.target, event);
    startedOnBackdrop = false;
    if (dismiss) close();
  });
  dialog.addEventListener("touchend", event => {
    const dismiss = startedOnBackdrop && event.touches.length === 0 && onBackdrop(event.target, event.changedTouches[0]);
    startedOnBackdrop = false;
    if (!dismiss) return;
    // suppress the synthesized click before exposing the controls behind the dialog
    event.preventDefault();
    close();
  }, { passive: false });
}
