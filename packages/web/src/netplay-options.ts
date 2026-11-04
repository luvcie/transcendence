import { normalizeInputLead } from "./session";

/** URL authorization is independent of the localStorage diagnostics preference. */
export function experimentalInputLead(params: URLSearchParams): number {
  const value = params.get("lead");
  if (!params.has("diagnostics") || value === null || !/^\d+(?:\.\d+)?$/.test(value)) return 0;
  return normalizeInputLead(Number(value));
}
