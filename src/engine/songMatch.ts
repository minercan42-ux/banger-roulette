import type { Media } from '../shared/primitives';

/**
 * Host-side, deterministic "same song" rule for Spiritually Linked groups
 * (issue #106). Two submissions are the same song when their video ids are
 * equal, or when both channels belong to the artist and duration, version
 * markers, unknown title parts, track name and artist all agree.
 * False positives are worse than false negatives, so every guard errs on the
 * side of "not linked". Pure: no randomness, no clock, no I/O.
 */

export type MatchMedia = Pick<
  Media,
  'videoId' | 'title' | 'channel' | 'durationSeconds'
>;

const MIN_DURATION_TOLERANCE_SECONDS = 4;
const DURATION_TOLERANCE_RATIO = 0.03;

/**
 * Channels that are never the artist's own, whatever else the name says.
 * Single words match whole tokens; phrases match the whole word sequence.
 */
const DENIED_CHANNEL_TOKENS: ReadonlySet<string> = new Set([
  'fan',
  'fans',
  'lyric',
  'lyrics',
  'karaoke',
  'cover',
  'covers',
  'tribute',
  'nightcore',
  'slowed',
  'sped',
  '8d',
]);
const DENIED_CHANNEL_PHRASES: readonly string[] = [
  'sing king',
  '7clouds',
  'lyrical lemon',
];

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
const FEATURING = /\s(?:feat|ft|featuring)\b\.?(.*)$/;
const CREDIT_START = /^(?:feat|ft|featuring)\b\.?/;
/** The only words a channel name may carry on top of the artist's name. */
const CHANNEL_SUFFIX_WORDS: readonly string[] = [
  'official',
  'music',
  'records',
];
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
  /** Sorted text of every unknown bracket/pipe segment, joined. */
  extraKey: string;
  /**
   * The uploading channel is the artist's own (channel guard): not denied,
   * and either a subset of the title's artist tokens, or a Topic/VEVO channel
   * standing in for an artist the title does not name.
   */
  channelOk: boolean;
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

/**
 * The artist a channel stands for: " - Topic", a trailing "VEVO" and the
 * trailing words Official, Music and Records are dropped, nothing else.
 * CamelCase VEVO names ("LionelRichieVEVO") are split into words first.
 */
function channelKey(rawChannel: string): string {
  const raw = /vevo\s*$/i.test(rawChannel)
    ? rawChannel.replace(CAMEL_BOUNDARY, ' ')
    : rawChannel;
  const base = normalizeText(raw).replace(/\s+-\s*topic\s*$/, '');
  const words = collapse(toWords(base)).replace(/\s*vevo$/, '');
  const tokens = words.split(' ').filter((token) => token !== '');
  while (
    tokens.length > 0 &&
    CHANNEL_SUFFIX_WORDS.includes(tokens[tokens.length - 1])
  ) {
    tokens.pop();
  }
  return tokens.join(' ');
}

const CAMEL_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu;

/** A fan, lyric, karaoke or cover channel never links a different upload. */
function isDeniedChannel(rawChannel: string): boolean {
  for (const text of [rawChannel, rawChannel.replace(CAMEL_BOUNDARY, ' ')]) {
    const words = collapse(toWords(normalizeText(text)));
    if (words.split(' ').some((word) => DENIED_CHANNEL_TOKENS.has(word))) {
      return true;
    }
    const padded = ` ${words} `;
    if (DENIED_CHANNEL_PHRASES.some((name) => padded.includes(` ${name} `))) {
      return true;
    }
  }
  return false;
}

/** Only Topic and VEVO channels are trusted to name the artist themselves. */
function isArtistFeedChannel(rawChannel: string): boolean {
  return (
    /\s-\s*topic\s*$/.test(normalizeText(rawChannel)) ||
    /vevo\s*$/i.test(rawChannel)
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

/**
 * A bracket or pipe segment. Credits only matter when they hide a version
 * marker ("(feat. X live)"); noise vanishes; a marker segment is compared as
 * text; anything else is unknown and stays part of the comparison key, so
 * "Hello (Goodbye)" never equals "Hello (Again)".
 */
function classifySegment(
  segment: string,
  versionTexts: Set<string>,
  extras: string[],
  credits: string[],
): void {
  const credit = CREDIT_START.exec(segment.trim());
  if (credit) {
    const tail = segment.trim().slice(credit[0].length);
    credits.push(tail);
    noteCreditTail(tail, versionTexts);
    return;
  }
  const cleaned = cleanSegment(segment);
  if (cleaned === '') {
    return;
  }
  if (hasMarker(cleaned)) {
    versionTexts.add(cleaned);
  } else {
    extras.push(cleaned);
  }
}

/** The text after ft./feat./featuring may carry "live", "remix" and so on. */
function noteCreditTail(tail: string, versionTexts: Set<string>): void {
  const cleaned = cleanSegment(tail);
  if (cleaned !== '' && hasMarker(cleaned)) {
    versionTexts.add(cleaned);
  }
}

function parseSong(media: MatchMedia): ParsedSong {
  const title = normalizeText(media.title);
  const { rest, inner } = extractBrackets(title);
  const [main, ...afterPipe] = rest.split('|');
  // Preserve empty parts: an explicit but missing track must not fall back to
  // treating the artist as the track on a Topic/VEVO channel.
  const parts = main.split(/\s-+\s/).map((part) => part.trim());
  const versionTexts = new Set<string>();
  const extras: string[] = [];
  /** Featured-artist texts: they count as the artist for the channel guard. */
  const credits: string[] = [];

  // The first two dash parts are the artist/track pair, even when the track
  // itself is "Song", "Music" or another noise word. Only later parts can be
  // discarded as upload metadata.
  while (parts.length > 2) {
    const cleaned = cleanSegment(parts[parts.length - 1]);
    if (cleaned === '') {
      parts.pop();
    } else if (hasMarker(cleaned)) {
      versionTexts.add(cleaned);
      parts.pop();
    } else {
      break;
    }
  }
  for (const segment of [...inner, ...afterPipe]) {
    classifySegment(segment, versionTexts, extras, credits);
  }

  // Version information is read from the credit tail before the credit is cut.
  const credited = parts.map((part) => {
    const found = FEATURING.exec(part);
    if (!found) {
      return part;
    }
    credits.push(found[1]);
    noteCreditTail(found[1], versionTexts);
    return part.slice(0, found.index);
  });
  const channel = channelKey(media.channel);
  const denied = isDeniedChannel(media.channel);
  let artist: string;
  let trackSource: string;
  let channelOk: boolean;
  if (credited.length === 2) {
    artist = collapse(toWords(credited[0]));
    trackSource = credited[1];
    channelOk =
      !denied &&
      isSubset(
        channel,
        collapse(`${artist} ${credits.map(toWords).join(' ')}`),
      );
  } else {
    // No artist in the title: only Topic and VEVO channels name the artist.
    trackSource = credited.join(' ');
    const fromChannel = !denied && isArtistFeedChannel(media.channel);
    artist = fromChannel ? channel : '';
    channelOk = fromChannel && channel !== '';
  }
  const track = collapse(trimTrailingNoise(toWords(trackSource)));
  // The raw text the title carried before noise words, credits, pipe and
  // bracket segments were dropped: the track part itself for an artist/track
  // pair, the whole title otherwise.
  const originalTrack = collapse(
    toWords(credited.length === 2 ? parts[1] : title),
  );
  // Stripping a credit, a bare noise suffix or a pipe/bracket segment must not
  // manufacture a track equal to the artist ("Adele | Song" on the Adele Topic
  // channel is not the track "Adele"). Keep that ambiguous parse out of
  // metadata matching.
  channelOk &&= track !== '' && !(track === artist && track !== originalTrack);
  if (hasMarker(track)) {
    versionTexts.add(track);
  }
  const channelWords = toWords(normalizeText(media.channel));
  for (const marker of CHANNEL_MARKERS) {
    const found = marker.exec(channelWords);
    if (found) {
      versionTexts.add(`channel ${found[0]}`);
    }
  }
  return {
    artist,
    track,
    versionKey: [...versionTexts].sort().join('|'),
    extraKey: [...extras].sort().join('|'),
    channelOk,
  };
}

function artistTokens(artist: string): Set<string> {
  return new Set(
    artist
      .split(' ')
      .filter((token) => token !== '' && !ARTIST_STOPWORDS.has(token)),
  );
}

/** A non-empty channel whose every token is among the artist's tokens. */
function isSubset(channel: string, artistWords: string): boolean {
  const own = artistTokens(channel);
  if (own.size === 0) {
    return false;
  }
  const allowed = artistTokens(artistWords);
  return [...own].every((token) => allowed.has(token));
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
  if (!a.parsed.channelOk || !b.parsed.channelOk) {
    return false;
  }
  if (
    a.parsed.versionKey !== b.parsed.versionKey ||
    a.parsed.extraKey !== b.parsed.extraKey
  ) {
    return false;
  }
  if (a.parsed.track === '' || a.parsed.track !== b.parsed.track) {
    return false;
  }
  // Artist token sets must be equal (stop words and order ignored), so
  // "Calvin Harris & Dua Lipa" still links "Dua Lipa & Calvin Harris" while
  // "Pink" never links "Pink Floyd". A partial overlap is not enough: different
  // songs must never be merged, recall may drop.
  const artist = artistTokens(a.parsed.artist);
  const otherArtist = artistTokens(b.parsed.artist);
  return (
    artist.size > 0 &&
    artist.size === otherArtist.size &&
    [...artist].every((token) => otherArtist.has(token))
  );
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
