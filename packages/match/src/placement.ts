import type { Attack, LockResult } from "@42tris/core";
import type { GarbageQueue, QueueRecord } from "./garbage";

interface PlacementLedger {
  garbage: GarbageQueue;
  sent: number;
}

/** send returns whether a recipient exists; only accepted outgoing lines count as sent. */
export function settlePlacement(ledger: PlacementLedger, result: LockResult, attacksEnabled: boolean,
  send: (attack: Attack) => boolean): { holes: number[]; records: QueueRecord[] } {
  const records: QueueRecord[] = [];
  for (const attack of result.attacks) {
    const bonus = result.stats.pieces <= 14 && ledger.garbage.pending >= ledger.sent ? attack.lines : 0;
    const lines = ledger.garbage.cancel(attack.lines, bonus, records);
    if (lines && attacksEnabled && send({ kind: attack.kind, lines })) ledger.sent += lines;
  }
  const holes = result.rows.length ? [] : ledger.garbage.insert(result.atMs, records);
  return { holes, records };
}
