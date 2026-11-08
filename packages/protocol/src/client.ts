import { treaty } from "@elysiajs/eden";
import { TypeCompiler } from "elysia/type-system";
import type { App } from "../../server/src/app";
import { ServerMessageSchema, type ServerMessage } from "./index";

const serverMessage = TypeCompiler.Compile(ServerMessageSchema);

/** Validate the transport envelope; nested simulation state remains trusted Match output. */
export function decodeServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(data); }
  catch { return null; }
  return serverMessage.Check(value) ? value : null;
}

export const createClient = (origin: string) => treaty<App>(origin);
export type { App };
