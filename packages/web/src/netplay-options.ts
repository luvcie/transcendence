import { MAX_INPUT_LEAD_MS } from "@42tris/protocol";
import { normalizeInputLead } from "./session";

/** URL authorization is independent of the localStorage diagnostics preference. */
export function configuredInputLead(params: URLSearchParams): number | "auto" | undefined {
  const value = params.get("lead");
  if (!params.has("diagnostics") || value === null) return undefined;
  if (value === "auto") return params.getAll("lead").length === 1 ? "auto" : undefined;
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > MAX_INPUT_LEAD_MS) return undefined;
  return normalizeInputLead(Number(value));
}

/** Retain the numeric parser's zero default for callers that do not need mode metadata. */
export function experimentalInputLead(params: URLSearchParams): number | "auto" {
  return configuredInputLead(params) ?? 0;
}
