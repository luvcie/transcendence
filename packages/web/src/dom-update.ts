export function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export function setHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) element.hidden = hidden;
}

export function setDisabled(element: HTMLButtonElement, disabled: boolean): void {
  if (element.disabled !== disabled) element.disabled = disabled;
}

export function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
