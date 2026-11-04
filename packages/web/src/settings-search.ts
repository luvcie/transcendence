export function setupSettingsSearch(input: HTMLInputElement, list: HTMLElement, empty: HTMLElement) {
  function filter() {
    const query = input.value.trim().toLowerCase();
    let visible = 0;
    for (const child of list.children) {
      const item = child as HTMLElement;
      item.hidden = !item.dataset.search!.toLowerCase().includes(query);
      if (!item.hidden) visible++;
    }
    empty.hidden = visible !== 0;
  }
  input.addEventListener("input", filter);
  return filter;
}
