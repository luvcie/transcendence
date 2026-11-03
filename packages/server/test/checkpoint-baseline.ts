import { FRAME_MS } from "@42tris/core";
import { Rooms } from "../src/rooms";

/** Pre-N2-B checkpoint path, kept only for deterministic comparisons and benchmarks. */
export function useLegacyCheckpoints(rooms: Rooms): void {
  let serverSequence = 0;
  rooms.checkpoint = (room, seat) => {
    if (!seat.peer) return;
    const pendingAccepted = [...seat.pending.values()];
    const simulationNow = room.phase !== "playing" || room.origin === null ? room.frozenTime
      : Math.max(0, rooms.now() - room.origin - room.pausedTotal);
    seat.peer.send({ type: "checkpoint", serverSequence: ++serverSequence, serverNow: rooms.now(), room: rooms.view(room), matchId: room.matchId,
      state: room.match?.saveState() ?? null,
      owner: { generation: seat.generation, epoch: room.match?.roster.includes(seat.id) ? room.match.playerEpoch(seat.id) : 0,
        nextSeq: seat.nextSeq, resolvedThroughSeq: pendingAccepted.length ? Math.min(...pendingAccepted.map(i => i.seq)) - 1 : seat.nextSeq - 1,
        pendingAccepted, rejections: [...seat.rejections] },
      clock: { currentTargetFrame: Math.floor(simulationNow / FRAME_MS), simulationNow, origin: room.origin, pausedTotal: room.pausedTotal,
        commitDelayMs: 100, frozen: room.phase !== "playing" }, roundDurations: room.roundDurations.map(duration => ({ ...duration })), events: [...room.events] }, true);
  };
  rooms.broadcastCheckpoint = room => { for (const seat of room.seats) rooms.checkpoint(room, seat); };
}
