import { useEffect, useRef } from 'react';
import {
  selectGenrePool,
  selectPhaseTimer,
  selectReveal,
  selectRoom,
  selectSettings,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState, Phase } from '../shared/game';
import { usePrefersReducedMotion } from './motion';
import { genreTargetAngle, reelAngle, reelTicks, reelTimeline } from './reel';
import { playEvents, type SfxEvent } from './sfx';
import { useSessionNow } from './use-session-now';

/** Cap on ticks for a single state change, so a sleeping tab cannot burst. */
const MAX_TICKS_PER_STEP = 8;

/** The slice of the shared state the effect layer reacts to. */
export interface SfxSnapshot {
  phase: Phase['type'];
  /** The reel really animates in this snapshot (GENRE_SPIN, no reduced motion, before the stop). */
  spinning: boolean;
  /** Rows that passed the reel window; frozen while the room is paused. */
  spinTicks: number;
  /** Linked entries already on screen; the reveal is where they become public. */
  linkedEntries: number;
  /** Reveal entries already revealed, worst first (FR-60). */
  revealedEntries: number;
  /** Banger entries (every rating 10) already revealed; each gets its own show. */
  bangerEntries: number;
  /**
   * Whether the round winner's entry is on screen already. A winning banger
   * does not count: its show replaces the jackpot.
   */
  winnerRevealed: boolean;
}

/**
 * Derive the effects two consecutive snapshots imply. Pure on purpose: the
 * phase components stay untouched and the reveal staging stays the only clock.
 */
export function sfxEventsFor(prev: SfxSnapshot, next: SfxSnapshot): SfxEvent[] {
  // SPEC §6: nothing plays while a clip runs, so effects never fight the music
  // of the preroll or of a song.
  if (next.phase === 'PLAYBACK') {
    return [];
  }
  const events: SfxEvent[] = [];
  if (prev.spinning && next.spinning) {
    const ticks = Math.min(
      MAX_TICKS_PER_STEP,
      Math.max(0, next.spinTicks - prev.spinTicks),
    );
    for (let tick = 0; tick < ticks; tick += 1) {
      events.push('spinTick');
    }
  }
  if (prev.spinning && !next.spinning) {
    events.push('spinStop');
  }
  if (next.linkedEntries > prev.linkedEntries) {
    events.push('linked');
  }
  const revealed = Math.max(0, next.revealedEntries - prev.revealedEntries);
  // A banger brings its own sound: it is not announced by the plain blip too.
  const bangers = Math.min(
    revealed,
    Math.max(0, next.bangerEntries - prev.bangerEntries),
  );
  for (let entry = 0; entry < revealed - bangers; entry += 1) {
    events.push('revealEntry');
  }
  for (let entry = 0; entry < bangers; entry += 1) {
    events.push('banger');
  }
  if (next.winnerRevealed && !prev.winnerRevealed) {
    events.push('jackpot');
  }
  if (next.phase !== prev.phase) {
    events.push('phaseChange');
  }
  if (next.phase === 'FINAL' && prev.phase !== 'FINAL') {
    events.push('final');
  }
  return events;
}

/** Read the snapshot out of shared state at one instant of server time. */
export function sfxSnapshot(
  state: GameState,
  now: number,
  reducedMotion: boolean,
): SfxSnapshot {
  const room = selectRoom(state);
  const phase = room.phase;
  // A fixed-mode round shows a short notice instead of a reel (FR-10), and a
  // reduced-motion client jumps straight to the result.
  let spinning =
    phase === 'GENRE_SPIN' &&
    !reducedMotion &&
    selectSettings(state).genreMode !== 'fixed';
  let spinTicks = 0;
  if (spinning) {
    const timer = selectPhaseTimer(state, now);
    if (timer.totalMs !== null && timer.remainingMs !== null) {
      // One tick per row that passed the window; the reel stops (spinStop)
      // when the drum does, not when the phase ends after the hold.
      const elapsed = timer.totalMs - timer.remainingMs;
      const { spinMs } = reelTimeline(timer.totalMs);
      const pool = selectGenrePool(state);
      const target = genreTargetAngle(
        pool.findIndex((genre) => genre.id === room.genre?.id),
        pool.length,
      );
      spinTicks = reelTicks(reelAngle(elapsed, spinMs, target));
      spinning = elapsed < spinMs;
    }
  }
  // The reveal is the first place a link is public (AK-3): while anonymity is
  // on, the submission phase only knows about the link, the entry shows it, and
  // LinkedAnimation rides along with the entry itself (FR-26).
  const reveal = selectReveal(state);
  const reference = reveal === null ? now : (reveal.pausedAt ?? now);
  const visible =
    reveal === null
      ? []
      : reveal.entries.filter((entry) => entry.revealAt <= reference);
  let linkedEntries = 0;
  for (const entry of visible) {
    if (entry.linked) {
      linkedEntries += 1;
    }
  }
  return {
    phase,
    spinning,
    spinTicks,
    linkedEntries,
    revealedEntries: visible.length,
    bangerEntries: visible.filter((entry) => entry.banger).length,
    winnerRevealed: visible.some((entry) => entry.winner && !entry.banger),
  };
}

/**
 * SPEC §6 effects, driven by shared state only: every client derives the same
 * events from the same snapshot, so the room hears one sound design. Renders
 * nothing and stays silent while the tab's effects are off or not unlocked.
 */
export function SfxDirector({
  session,
  state,
}: {
  session: GameSession;
  state: GameState;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const room = selectRoom(state);
  const staged = room.phase === 'GENRE_SPIN' || room.phase === 'REVEAL';
  const now = useSessionNow(session, staged && !room.paused);
  const snapshot = sfxSnapshot(state, now, reducedMotion);
  const previous = useRef<SfxSnapshot | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = snapshot;
    // The first snapshot is a position, not a transition: entering a running
    // room, reloading or joining late must not fire a backlog of effects.
    if (before !== null) {
      playEvents(sfxEventsFor(before, snapshot));
    }
  }, [snapshot]);
  return null;
}
