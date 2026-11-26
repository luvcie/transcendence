export function createSettingsGroup(list: HTMLElement, label: string, open: boolean) {
  const document = list.ownerDocument;
  const group = document.createElement("details");
  group.className = "catalog-group";
  group.open = open;
  const heading = document.createElement("summary");
  heading.textContent = label;
  const count = document.createElement("span");
  heading.append(count);
  const options = document.createElement("div");
  group.append(heading, options);
  list.append(group);
  return options;
}

export function setupSettingsSearch(input: HTMLInputElement, list: HTMLElement, empty: HTMLElement) {
  function filter() {
    const query = input.value.trim().toLowerCase();
    function filterItem(item: HTMLElement): [number, number] {
      const { search } = item.dataset;
      if (search !== undefined) {
        item.hidden = !search.toLowerCase().includes(query);
        return [item.hidden ? 0 : 1, 1];
      }
      const group = item as HTMLDetailsElement;
      const [heading, options] = group.children;
      if (query && group.dataset.searchOpen === undefined) group.dataset.searchOpen = String(group.open);
      if (!query && group.dataset.searchOpen !== undefined) {
        group.open = group.dataset.searchOpen === "true";
        delete group.dataset.searchOpen;
      }
      let matches = 0, total = 0;
      for (const child of options.children) {
        const [childMatches, childTotal] = filterItem(child as HTMLElement);
        matches += childMatches;
        total += childTotal;
      }
      heading.children[0].textContent = query ? `${matches}/${total}` : String(total);
      group.hidden = matches === 0;
      if (query) group.open = matches > 0;
      return [matches, total];
    }
    let visible = 0;
    for (const child of list.children) visible += filterItem(child as HTMLElement)[0];
    empty.hidden = visible !== 0;
  }
  input.addEventListener("input", filter);
  return filter;
}
