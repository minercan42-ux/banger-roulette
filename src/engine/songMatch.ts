import type { Media } from '../shared/primitives';

/**
 * Host-side, deterministic "same song" rule for Spiritually Linked groups
 * (issue #106). Two submissions are the same song when their video ids are
 * equal, or when duration, version markers, track name and artist all agree.
 * False positives are worse than false negatives, so every guard errs on the
 * side of "not linked". Pure: no randomness, no clock, no I/O.
 */

export type MatchMedia = Pick<
  Media,
  'videoId' | 'title' | 'channel' | 'durationSeconds'
>;

const MIN_DURATION_TOLERANCE_SECONDS = 4;
const DURATION_TOLERANCE_RATIO = 0.03;
const ARTIST_JACCARD_MIN = 0.5;

/**
 * Version markers: a segment that carries one of these describes a different
 * recording or edit of the song. The text of every marker-bearing segment must
 * match between two uploads, so "(Live)" never equals "(Live at Wembley)" and
 * "(A Remix)" never equals "(B Remix)". Matched on punctuation-free words.
 */
const VERSION_MARKERS: readonly RegExp[] = [
  /\blive\b/,
  /\bremix(?:es|ed)?\b/,
  /\brmx\b/,
  /\bcovers?\b/,
  /\bacoustic\b/,
  /\bunplugged\b/,
  /\bslowed\b/,
  /\breverb\b/,
  /\bsped up\b/,
  /\bspeed ?up\b/,
  /\bnightcore\b/,
  /\binstrumental\b/,
  /\bkaraoke\b/,
  /\b8d\b/,
  /\bbass boosted\b/,
  /\bextended\b/,
  /\bradio edit\b/,
  /\bedits?\b/,
  /\bdemo\b/,
  /\bmashup\b/,
  /\bmix(?:es)?\b/,
  /\bversion\b/,
  /\bver\b/,
  /\brework(?:ed)?\b/,
  /\bbootleg\b/,
  /\bvip\b/,
  /\bflip\b/,
  /\bpiano\b/,
  /\borchestral\b/,
  /\ba ?cappella\b/,
  /\bacapella\b/,
  /\bre ?recorded\b/,
  /\bdub\b/,
  /\bstripped\b/,
  /\bsessions?\b/,
  /\breprise\b/,
  /\b(?:part|pt) \d+\b/,
  /\bskit\b/,
  /\binterlude\b/,
  /\bintro\b/,
  /\boutro\b/,
  /\balternate\b/,
  /\balternative\b/,
  /\blo ?fi\b/,
  /\bchopped\b/,
  /\bscrewed\b/,
  /\bmegamix\b/,
  /\btribute\b/,
];

/**
 * Channel names rarely carry a marker, but when they do ("Nightcore Hub",
 * "Karaoke Channel") the title often omits it. Only unambiguous markers count:
 * words such as "live" or "intro" are too common in ordinary channel names.
 */
const CHANNEL_MARKERS: readonly RegExp[] = [
  /\bremix(?:es)?\b/,
  /\bcovers?\b/,
  /\bkaraoke\b/,
  /\bnightcore\b/,
  /\binstrumentals?\b/,
  /\bpiano\b/,
  /\bacoustic\b/,
  /\bslowed\b/,
  /\breverb\b/,
  /\b8d\b/,
  /\bbass boosted\b/,
  /\bsped up\b/,
  /\bmashups?\b/,
  /\bbootlegs?\b/,
  /\bre ?works?\b/,
  /\borchestral\b/,
];

/** Remaster tags (with optional year) are noise, not a different recording. */
const REMASTER =
  /\b(?:\d{4} )?(?:digital |digitally )?re ?master(?:ed)?(?: version| edition)?(?: \d{4})?\b/g;
const ORIGINAL_MIX = /\boriginal mix\b/g;
const NOISE =
  /\b(?:official|oficial|music|video|videoclip|clip|audio|audio only|lyrics?|lyrical|lyric video|paroles|letra|testo|visuali[sz]er|hd|hq|uhd|full hd|4k|8k|1080p|720p|mv|m v|explicit|clean|stereo|out now|premiere|full song|full audio|full video|with lyrics|high quality|song|topic|vevo|new)\b/g;
/**
 * Noise that may trail the title itself without brackets ("Hello Lyrics").
 * Bare "audio", "video" or "music" are excluded: they end real track names.
 */
const TRAILING_NOISE =
  /\s(?:official (?:hd )?(?:music )?(?:video|audio|lyric video|lyrics|visuali[sz]er)|lyric video|lyrics?|music video|visuali[sz]er|full (?:song|video|audio)|hd|hq|4k)$/;
const FEATURING = /\s(?:feat|ft|featuring)\b\.?.*$/;
const BRACKETS =
  /\([^()[\]{}]*\)|\[[^()[\]{}]*\]|\{[^()[\]{}]*\}|【[^】]*】|「[^」]*」|『[^』]*』|〈[^〉]*〉|《[^》]*》/g;
const ARTIST_STOPWORDS: ReadonlySet<string> = new Set(['and', 'x']);

interface ParsedSong {
  /** Normalized artist words ('' when unknown). */
  artist: string;
  /** Normalized track words ('' when unknown). */
  track: string;
  /** Sorted text of every version-bearing segment, joined. */
  versionKey: string;
}

/** NFKC, lowercase, strip Latin diacritics, unify quotes and dashes. */
function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/(?<=\p{Script=Latin}\p{M}*)\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201B\u2032\u00B4`\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

/** Words only: apostrophes vanish, "&" becomes "and", other punctuation spaces. */
function toWords(value: string): string {
  return value
    .replace(/'/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Segment text without remaster, "original mix" and noise words. */
function cleanSegment(value: string): string {
  return collapse(
    toWords(value)
      .replace(REMASTER, ' ')
      .replace(ORIGINAL_MIX, ' ')
      .replace(NOISE, ' '),
  );
}

function hasMarker(cleaned: string): boolean {
  return VERSION_MARKERS.some((marker) => marker.test(cleaned));
}

function isMarkerOnly(cleaned: string): boolean {
  let rest = cleaned;
  for (const marker of VERSION_MARKERS) {
    rest = rest.replace(new RegExp(marker.source, 'g'), ' ');
  }
  return collapse(rest.replace(/\d+/g, ' ')) === '';
}

/** Pull every bracket group out of the title; returns the inner texts. */
function extractBrackets(title: string): { rest: string; inner: string[] } {
  const inner: string[] = [];
  let rest = title;
  for (;;) {
    let found = false;
    rest = rest.replace(BRACKETS, (group) => {
      found = true;
      inner.push(group.slice(1, -1));
      return ' ';
    });
    if (!found) {
      return { rest, inner };
    }
  }
}

function channelArtist(channel: string): string {
  return collapse(
    toWords(
      channel
        .replace(/\s*-\s*topic\s*$/, '')
        .replace(/vevo\s*$/, '')
        .replace(/\bofficial\b/g, ' ')
        .replace(/\bmusic\b/g, ' '),
    ),
  );
}

function trimTrailingNoise(track: string): string {
  let current = track;
  for (;;) {
    const next = current.replace(TRAILING_NOISE, '');
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function parseSong(media: MatchMedia): ParsedSong {
  const title = normalizeText(media.title);
  const { rest, inner } = extractBrackets(title);
  const [main, ...afterPipe] = rest.split('|');
  const segments = [...inner, ...afterPipe];
  const parts = main
    .split(/\s-+\s/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const versionTexts = new Set<string>();

  // Trailing " - " parts that are noise are dropped; marker-only ones (or any
  // marker part beyond the artist/track pair) become version segments.
  while (parts.length >= 2) {
    const cleaned = cleanSegment(parts[parts.length - 1]);
    if (cleaned === '') {
      parts.pop();
    } else if (
      hasMarker(cleaned) &&
      (parts.length >= 3 || isMarkerOnly(cleaned))
    ) {
      versionTexts.add(cleaned);
      parts.pop();
    } else {
      break;
    }
  }
  for (const segment of segments) {
    const cleaned = cleanSegment(segment);
    if (cleaned !== '' && hasMarker(cleaned)) {
      versionTexts.add(cleaned);
    }
  }

  const credited = parts.map((part) => part.replace(FEATURING, ''));
  const channelName = normalizeText(media.channel);
  let artist: string;
  let trackSource: string;
  if (credited.length === 2) {
    artist = toWords(credited[0]);
    trackSource = credited[1];
  } else {
    artist = channelArtist(channelName);
    trackSource = credited.join(' ');
  }
  const track = collapse(trimTrailingNoise(toWords(trackSource)));
  if (hasMarker(track)) {
    versionTexts.add(track);
  }
  const channelWords = toWords(channelName);
  for (const marker of CHANNEL_MARKERS) {
    const found = marker.exec(channelWords);
    if (found) {
      versionTexts.add(`channel ${found[0]}`);
    }
  }
  return {
    artist: collapse(artist),
    track,
    versionKey: [...versionTexts].sort().join('|'),
  };
}

function artistTokens(artist: string): Set<string> {
  return new Set(
    artist
      .split(' ')
      .filter((token) => token !== '' && !ARTIST_STOPWORDS.has(token)),
  );
}

function sameArtist(a: string, b: string): boolean {
  if (a === '' || b === '') {
    return false;
  }
  if (a === b || a.replaceAll(' ', '') === b.replaceAll(' ', '')) {
    return true;
  }
  const left = artistTokens(a);
  const right = artistTokens(b);
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  const union = left.size + right.size - shared;
  return union > 0 && shared / union >= ARTIST_JACCARD_MIN;
}

function durationsClose(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) {
    return false;
  }
  const tolerance = Math.max(
    MIN_DURATION_TOLERANCE_SECONDS,
    DURATION_TOLERANCE_RATIO * Math.min(a, b),
  );
  return Math.abs(a - b) <= tolerance;
}

/** Parse once, compare many times. */
export function prepareMatch(media: MatchMedia): PreparedMatch {
  return { media, parsed: parseSong(media) };
}

export interface PreparedMatch {
  media: MatchMedia;
  parsed: ParsedSong;
}

export function preparedSameSong(a: PreparedMatch, b: PreparedMatch): boolean {
  if (a.media.videoId === b.media.videoId) {
    return true;
  }
  if (!durationsClose(a.media.durationSeconds, b.media.durationSeconds)) {
    return false;
  }
  if (a.parsed.versionKey !== b.parsed.versionKey) {
    return false;
  }
  if (a.parsed.track === '' || a.parsed.track !== b.parsed.track) {
    return false;
  }
  return sameArtist(a.parsed.artist, b.parsed.artist);
}

export function isSameSong(a: MatchMedia, b: MatchMedia): boolean {
  return preparedSameSong(prepareMatch(a), prepareMatch(b));
}

/**
 * Union-find over actual pairwise matches: grouping is transitive only
 * through matching pairs. Returns groups of input indices, each ascending;
 * groups are ordered by their first index.
 */
export function groupSameSongs(items: readonly MatchMedia[]): number[][] {
  const prepared = items.map(prepareMatch);
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    return root;
  };
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      if (preparedSameSong(prepared[i], prepared[j])) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
          parent[Math.max(rootI, rootJ)] = Math.min(rootI, rootJ);
        }
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const root = find(index);
    const members = groups.get(root);
    if (members) {
      members.push(index);
    } else {
      groups.set(root, [index]);
    }
  }
  return [...groups.values()];
}
