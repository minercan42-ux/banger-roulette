import { VideoId } from '../shared/primitives';

/**
 * Supported YouTube link shapes (FR-20). Other hosts and routes are rejected
 * instead of guessed so a submission can never point at an arbitrary target.
 */
const WATCH_HOSTS: Record<string, true> = {
  'youtube.com': true,
  'www.youtube.com': true,
  'm.youtube.com': true,
  'music.youtube.com': true,
};
const SHORT_HOST = 'youtu.be';

export interface ParsedYouTubeLink {
  videoId: string;
  /** Start suggestion from the `t` parameter, in whole seconds (0 when absent). */
  startSeconds: number;
}

/**
 * `t` accepts a plain number of seconds or the composite `1h2m3s` form that
 * YouTube's share dialog emits. A present but unparseable value is malformed
 * input, so the whole link is rejected rather than silently defaulted.
 */
const COMPOSITE_START = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

function parseStartSeconds(raw: string | null): number | null {
  if (raw === null) {
    return 0;
  }
  const value = raw.trim().toLowerCase();
  if (value === '') {
    return 0;
  }
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const match = COMPOSITE_START.exec(value);
  if (match === null) {
    return null;
  }
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }
  const total =
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Extracts the 11 character video id and the start suggestion from a supported
 * YouTube link. http/https only, no credentials and no explicit port. Returns
 * `null` for every malformed or unsupported input.
 */
export function parseYouTubeLink(input: string): ParsedYouTubeLink | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed === '') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }

  const host = url.hostname;
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  let candidate: string | undefined;

  if (host === SHORT_HOST) {
    if (segments.length !== 1) {
      return null;
    }
    candidate = segments[0];
  } else if (WATCH_HOSTS[host] === true) {
    if (segments.length === 1 && segments[0] === 'watch') {
      const ids = url.searchParams.getAll('v');
      if (ids.length !== 1) {
        return null;
      }
      candidate = ids[0];
    } else if (segments.length === 2 && segments[0] === 'shorts') {
      candidate = segments[1];
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (candidate === undefined || !VideoId.safeParse(candidate).success) {
    return null;
  }
  const startSeconds = parseStartSeconds(url.searchParams.get('t'));
  if (startSeconds === null) {
    return null;
  }
  return { videoId: candidate, startSeconds };
}
