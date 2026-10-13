import type { Genre } from '../shared/primitives';

/** Localized genre label; German is the fallback language (SPEC §2). */
export function genreName(genre: Genre, language: string | undefined): string {
  return language === 'en' ? genre.en : genre.de;
}

/** mm:ss for a non-negative millisecond duration. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Uppercase room code, limited to the six allowed alphabet letters. */
export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 6);
}

export const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
