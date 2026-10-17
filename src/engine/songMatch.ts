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
 * Keys without a space match a whole token, keys with a space the whole word
 * sequence. "lyric" is the only kind a lyric video may relax: it nearly always
 * carries the original recording (issue #133, narrows D-033), while fan, cover,
 * karaoke, tribute and nightcore channels keep the guard.
 */
const DENIED_CHANNEL_WORDS: Readonly<Record<string, 'lyric' | 'other'>> = {
  fan: 'other',
  fans: 'other',
  lyric: 'lyric',
  lyrics: 'lyric',
  karaoke: 'other',
  cover: 'other',
  covers: 'other',
  tribute: 'other',
  nightcore: 'other',
  slowed: 'other',
  sped: 'other',
  '8d': 'other',
  'sing king': 'other',
  '7clouds': 'lyric',
  'lyrical lemon': 'lyric',
};

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
const FEATURING = /\s(?:feat|ft|featuring)\b\.?(.*)$/i;
const CREDIT_START = /^(?:feat|ft|featuring)\b\.?/i;
/** The only words a channel name may carry on top of the artist's name. */
const CHANNEL_SUFFIX_WORDS: readonly string[] = [
  'official',
  'music',
  'records',
];
const BRACKETS =
  /\([^()[\]{}]*\)|\[[^()[\]{}]*\]|\{[^()[\]{}]*\}|【[^】]*】|「[^」]*」|『[^』]*』|〈[^〉]*〉|《[^》]*》/g;
const ARTIST_STOPWORDS: ReadonlySet<string> = new Set(['and', 'x']);

/**
 * How a source spelled one word: "U.S.A." is a dotted initialism, "USA" a
 * solid all-uppercase word, "Usa" an ordinary word. A dotted initialism is the
 * same word as another dotted initialism or a solid uppercase spelling, never
 * a mixed-case or lowercase one, so ordinary words stay case-insensitive.
 */
type WordKind = 'initialism' | 'upper' | 'word';

/** One word of an artist, track or channel, with the spelling it had there. */
interface SpelledWord {
  /** Normalized word: lowercase, the dots of an initialism dropped. */
  word: string;
  kind: WordKind;
}

interface ParsedSong {
  /** Artist words with their spelling (empty when unknown). */
  artistWords: readonly SpelledWord[];
  /** Track words with their spelling (empty when unknown). */
  trackWords: readonly SpelledWord[];
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

/**
 * NFKC, Latin diacritics stripped, quotes and dashes unified. Keeps the case,
 * so the raw spelling of every word stays readable.
 */
function normalizeShape(value: string): string {
  return value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/(?<=\p{Script=Latin}\p{M}*)\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201B\u2032\u00B4`\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

/** The shaped text in lower case, the form every comparison reads. */
function normalizeText(value: string): string {
  return normalizeShape(value).toLowerCase();
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

/**
 * A whole dotted initialism ("U.S.A.", "U.S.A", "u.s.a.", "R.E.M.") or a
 * plain word run. The dotted branch needs two or more single letters and a
 * boundary on both sides: "A.Muse" stays "a" and "muse", "2.0" never joins.
 */
const WORD_RUN =
  /(?<![\p{L}\p{N}])(?:\p{L}\.)+\p{L}\.?(?![\p{L}\p{N}])|[\p{L}\p{N}]+/gu;

/** A solid word of two or more capital letters: "USA", but not "Usa". */
const UPPERCASE_WORD = /^\p{Lu}{2,}$/u;

/** One word with the spelling the shaped source gave it. */
function spelledWord(raw: string): SpelledWord {
  // The first WORD_RUN branch matches only a dotted initialism, the second
  // never contains a dot.
  if (raw.includes('.')) {
    return { word: raw.replace(/\./g, '').toLowerCase(), kind: 'initialism' };
  }
  return {
    word: raw.toLowerCase(),
    kind: UPPERCASE_WORD.test(raw) ? 'upper' : 'word',
  };
}

/**
 * The words of a shaped text, each with the spelling it had there. Reads the
 * same word sequence toWords does: apostrophes vanish, "&" becomes "and".
 */
function spelledWords(value: string): SpelledWord[] {
  const prepared = value.replace(/'/g, '').replace(/&/g, ' and ');
  return [...prepared.matchAll(WORD_RUN)].map((match) => spelledWord(match[0]));
}

/** The words of a token list, as every comparison reads them. */
function wordsOf(words: readonly SpelledWord[]): string {
  return words.map((token) => token.word).join(' ');
}

/** Segment text without remaster, "original mix" and noise words. */
function cleanSegment(value: string): string {
  return collapse(
    toWords(normalizeText(value))
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
 * A CamelCase VEVO name ("LionelRichieVEVO") is split into words first; every
 * other channel name stays as it is.
 */
function channelText(rawChannel: string): string {
  return /vevo\s*$/i.test(rawChannel)
    ? rawChannel.replace(CAMEL_BOUNDARY, ' ')
    : rawChannel;
}

/**
 * The artist a channel stands for, as words: " - Topic", a trailing "VEVO"
 * and the trailing words Official, Music and Records are dropped, nothing
 * else.
 */
function channelKey(rawChannel: string): SpelledWord[] {
  const base = normalizeShape(channelText(rawChannel)).replace(
    /\s+-\s*topic\s*$/i,
    '',
  );
  const words = spelledWords(base);
  const last = words.at(-1);
  if (last !== undefined && last.word.endsWith('vevo')) {
    const word = last.word.slice(0, -'vevo'.length);
    if (word === '') {
      words.pop();
    } else {
      words[words.length - 1] = { ...last, word };
    }
  }
  while (
    words.length > 0 &&
    CHANNEL_SUFFIX_WORDS.includes(words[words.length - 1].word)
  ) {
    words.pop();
  }
  return words;
}

const CAMEL_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu;

interface ChannelJudge {
  /** The name carries a denied word: never the artist's own channel. */
  denied: boolean;
  /** Only lyric words deny it, no fan, cover, karaoke or tribute word. */
  lyricOnly: boolean;
}

/**
 * A fan, lyric, karaoke or cover channel never links a different upload.
 * Lyric words are reported separately: a lyric video carries the original
 * recording, so the caller may relax exactly those (issue #133).
 */
function judgeChannel(rawChannel: string): ChannelJudge {
  let denied = false;
  let lyric = false;
  let other = false;
  for (const text of [rawChannel, rawChannel.replace(CAMEL_BOUNDARY, ' ')]) {
    const words = collapse(toWords(normalizeText(text)));
    const padded = ` ${words} `;
    const tokens = words.split(' ');
    for (const [name, kind] of Object.entries(DENIED_CHANNEL_WORDS)) {
      const hit = name.includes(' ')
        ? padded.includes(` ${name} `)
        : tokens.includes(name);
      if (!hit) {
        continue;
      }
      denied = true;
      if (kind === 'lyric') {
        lyric = true;
      } else {
        other = true;
      }
    }
  }
  return { denied, lyricOnly: denied && lyric && !other };
}

/** Only Topic and VEVO channels are trusted to name the artist themselves. */
function isArtistFeedChannel(rawChannel: string): boolean {
  return (
    /\s-\s*topic\s*$/.test(normalizeText(rawChannel)) ||
    /vevo\s*$/i.test(rawChannel)
  );
}

/** Track words without the upload noise that trails the title. */
function trimTrailingNoise(track: readonly SpelledWord[]): SpelledWord[] {
  let current = [...track];
  for (;;) {
    const found = TRAILING_NOISE.exec(wordsOf(current));
    if (!found) {
      return current;
    }
    current = current.slice(
      0,
      current.length - found[0].trim().split(' ').length,
    );
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
  // The title keeps its case: every word must remember how it was spelled.
  const title = normalizeShape(media.title);
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
  const channelWords = channelKey(media.channel);
  const channelJudge = judgeChannel(media.channel);
  /** Featured artists, spelled as the title spells them. */
  const creditWords = credits.flatMap((credit) => spelledWords(credit));
  let artistWords: SpelledWord[];
  let trackSource: string;
  let channelOk: boolean;
  if (credited.length === 2) {
    artistWords = spelledWords(credited[0]);
    trackSource = credited[1];
    // A lyric channel uploads the original recording, so the parsed artist and
    // track pair replaces the channel guard there (issue #133). Every other
    // guard still applies, and only lyric words are relaxed.
    channelOk =
      channelJudge.lyricOnly ||
      (!channelJudge.denied &&
        isSubset(channelWords, [...artistWords, ...creditWords]));
  } else {
    // No artist in the title: only Topic and VEVO channels name the artist.
    trackSource = credited.join(' ');
    const fromChannel =
      !channelJudge.denied && isArtistFeedChannel(media.channel);
    artistWords = fromChannel ? channelWords : [];
    channelOk = fromChannel && channelWords.length > 0;
  }
  const trackWords = trimTrailingNoise(spelledWords(trackSource));
  channelOk &&= trackWords.length > 0;
  const track = wordsOf(trackWords);
  if (track === wordsOf(artistWords)) {
    // A self-titled track is certain only when the whole, unstripped title
    // spells the artist once or as an exact artist/track pair. Preserve the
    // artist's punctuation; toWords would hide extra raw title text.
    const rawChannel = channelText(media.channel);
    const rawArtist = collapse(
      credited.length === 2
        ? normalizeText(credited[0])
        : normalizeText(rawChannel)
            .replace(/\s+-\s*topic\s*$/, '')
            .replace(/\s*vevo$/, ''),
    );
    const rawTitle = collapse(normalizeText(media.title));
    channelOk &&=
      rawTitle === rawArtist || rawTitle === `${rawArtist} - ${rawArtist}`;
  }
  if (hasMarker(track)) {
    versionTexts.add(track);
  }
  const channelName = toWords(normalizeText(media.channel));
  for (const marker of CHANNEL_MARKERS) {
    const found = marker.exec(channelName);
    if (found) {
      versionTexts.add(`channel ${found[0]}`);
    }
  }
  return {
    artistWords,
    trackWords,
    versionKey: [...versionTexts].sort().join('|'),
    extraKey: [...extras].sort().join('|'),
    channelOk,
  };
}

/** A dotted initialism never matches an ordinary mixed-case or lowercase word. */
function spellingsClash(one: WordKind, other: WordKind): boolean {
  return (
    (one === 'initialism' && other === 'word') ||
    (one === 'word' && other === 'initialism')
  );
}

/**
 * Artist tokens by word, stop words dropped: a repeated word keeps the
 * spelling of its first occurrence.
 */
function artistTokens(words: readonly SpelledWord[]): Map<string, WordKind> {
  const tokens = new Map<string, WordKind>();
  for (const { word, kind } of words) {
    if (!ARTIST_STOPWORDS.has(word) && !tokens.has(word)) {
      tokens.set(word, kind);
    }
  }
  return tokens;
}

/** Same words in the same order, and no initialism meets an ordinary word. */
function trackAgree(
  one: readonly SpelledWord[],
  other: readonly SpelledWord[],
): boolean {
  return (
    one.length === other.length &&
    one.every(
      (token, index) =>
        token.word === other[index].word &&
        !spellingsClash(token.kind, other[index].kind),
    )
  );
}

/**
 * Artist token sets must be equal (stop words and order ignored), so
 * "Calvin Harris & Dua Lipa" still links "Dua Lipa & Calvin Harris" while
 * "Pink" never links "Pink Floyd". A partial overlap is not enough: different
 * songs must never be merged, recall may drop. The words must also be spelled
 * alike: a dotted initialism never meets a mixed-case "Pod" (issue #133).
 */
function artistAgree(
  one: readonly SpelledWord[],
  other: readonly SpelledWord[],
): boolean {
  const own = artistTokens(one);
  const theirs = artistTokens(other);
  if (own.size === 0 || own.size !== theirs.size) {
    return false;
  }
  return [...own].every(([word, kind]) => {
    const otherKind = theirs.get(word);
    return otherKind !== undefined && !spellingsClash(kind, otherKind);
  });
}

/** A non-empty channel whose every token is among the artist's, spelled alike. */
function isSubset(
  channel: readonly SpelledWord[],
  artistWords: readonly SpelledWord[],
): boolean {
  const own = artistTokens(channel);
  if (own.size === 0) {
    return false;
  }
  const allowed = artistTokens(artistWords);
  return [...own].every(([word, kind]) => {
    const otherKind = allowed.get(word);
    return otherKind !== undefined && !spellingsClash(kind, otherKind);
  });
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
  if (a.parsed.trackWords.length === 0) {
    return false;
  }
  return (
    trackAgree(a.parsed.trackWords, b.parsed.trackWords) &&
    artistAgree(a.parsed.artistWords, b.parsed.artistWords)
  );
}

/**
 * A pair that may not share a group: same words, but a dotted initialism meets
 * an ordinary word. Identical video ids are the same upload and the duration
 * guard may chain, so only a spelling clash blocks a union (issue #133 review).
 */
function spellingClash(a: PreparedMatch, b: PreparedMatch): boolean {
  if (a.media.videoId === b.media.videoId) {
    return false;
  }
  return (
    !trackAgree(a.parsed.trackWords, b.parsed.trackWords) ||
    !artistAgree(a.parsed.artistWords, b.parsed.artistWords)
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
  const indices = items.map((_, index) => index);
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI === rootJ || !preparedSameSong(prepared[i], prepared[j])) {
        continue;
      }
      // Spelling is complete linkage: the duration guard may chain uploads, a
      // dotted initialism may not reach an ordinary word anywhere in the
      // merged group (issue #133 review).
      const clash = indices.some(
        (left) =>
          find(left) === rootI &&
          indices.some(
            (right) =>
              find(right) === rootJ &&
              spellingClash(prepared[left], prepared[right]),
          ),
      );
      if (!clash) {
        parent[Math.max(rootI, rootJ)] = Math.min(rootI, rootJ);
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
