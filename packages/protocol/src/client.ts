import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/src/app";

export const createClient = (origin: string) => treaty<App>(origin);
export type { App };
