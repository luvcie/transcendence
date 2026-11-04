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
    function filterGroup(group: HTMLDetailsElement): [number, number] {
      const [heading, options] = group.children;
      if (query && group.dataset.searchOpen === undefined) group.dataset.searchOpen = String(group.open);
      if (!query && group.dataset.searchOpen !== undefined) {
        group.open = group.dataset.searchOpen === "true";
        delete group.dataset.searchOpen;
      }
      let matches = 0, total = 0;
      for (const child of options.children) {
        const item = child as HTMLElement;
        if (item.dataset.search !== undefined) {
          item.hidden = !item.dataset.search.toLowerCase().includes(query);
          if (!item.hidden) matches++;
          total++;
        } else {
          const [childMatches, childTotal] = filterGroup(item as HTMLDetailsElement);
          matches += childMatches;
          total += childTotal;
        }
      }
      heading.children[0].textContent = query ? `${matches}/${total}` : String(total);
      group.hidden = matches === 0;
      if (query) group.open = matches > 0;
      return [matches, total];
    }
    let visible = 0;
    for (const group of list.children) visible += filterGroup(group as HTMLDetailsElement)[0];
    empty.hidden = visible !== 0;
  }
  input.addEventListener("input", filter);
  return filter;
}
