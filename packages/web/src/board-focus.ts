export function mountBoardFocus(
  board: HTMLElement,
  getGrid: () => { cells: readonly HTMLButtonElement[]; cols: number },
) {
  board.addEventListener("focusin", event => {
    const { cells } = getGrid();
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !cells.includes(target)) return;
    board.querySelector<HTMLButtonElement>('[tabindex="0"]')?.setAttribute("tabindex", "-1");
    target.tabIndex = 0;
  });

  board.addEventListener("keydown", event => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const { cells, cols } = getGrid();
    const index = cells.indexOf(target);
    if (index < 0) return;
    const col = index % cols;
    switch (event.key) {
      case "ArrowLeft": if (col > 0) cells[index - 1]?.focus(); break;
      case "ArrowRight": if (col < cols - 1) cells[index + 1]?.focus(); break;
      case "ArrowUp": cells[index - cols]?.focus(); break;
      case "ArrowDown": cells[index + cols]?.focus(); break;
      default: return;
    }
    event.preventDefault();
  });
}
