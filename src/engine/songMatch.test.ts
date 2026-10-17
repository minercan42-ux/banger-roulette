import { describe, expect, it } from 'vitest';
import { groupSameSongs, isSameSong, type MatchMedia } from './songMatch';

let counter = 0;
function upload(
  title: string,
  channel: string,
  durationSeconds: number,
  videoId?: string,
): MatchMedia {
  counter += 1;
  return {
    videoId: videoId ?? `u${counter.toString().padStart(10, '0')}`,
    title,
    channel,
    durationSeconds,
  };
}

type Row = [string, MatchMedia, MatchMedia];

const linked: Row[] = [
  [
    'official video vs Topic upload',
    upload(
      'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      'Rick Astley',
      213,
    ),
    upload('Never Gonna Give You Up', 'Rick Astley - Topic', 213),
  ],
  [
    'official video vs lyric video on the artist Topic channel',
    upload('Adele - Hello (Official Music Video)', 'Adele', 367),
    upload('Adele - Hello (Lyrics)', 'Adele - Topic', 366),
  ],
  [
    'VEVO channel vs official audio',
    upload('Hello', 'LionelRichieVEVO', 282),
    upload('Lionel Richie - Hello (Official Audio)', 'Lionel Richie', 281),
  ],
  [
    'remastered vs original',
    upload(
      'Queen - Bohemian Rhapsody (Remastered 2011)',
      'Queen Official',
      355,
    ),
    upload('Queen - Bohemian Rhapsody (Official Video)', 'Queen Official', 355),
  ],
  [
    'year remaster tag after a dash',
    upload(
      'Dire Straits - Brothers In Arms - 2022 Remaster',
      'Dire Straits',
      336,
    ),
    upload('Dire Straits - Brothers In Arms', 'Dire Straits', 337),
  ],
  [
    'bracketed noise and HD tag',
    upload('Daft Punk - Get Lucky (Official Audio) [HD]', 'Daft Punk', 248),
    upload('Daft Punk - Get Lucky | Official Video', 'DaftPunkVEVO', 248),
  ],
  [
    'featuring clause in title vs without',
    upload(
      'Daft Punk - Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
      'Daft Punk',
      369,
    ),
    upload('Daft Punk - Get Lucky', 'Daft Punk - Topic', 368),
  ],
  [
    'ft. suffix in the track part',
    upload('Eminem - Love The Way You Lie ft. Rihanna', 'EminemVEVO', 263),
    upload('Eminem - Love The Way You Lie', 'Eminem', 262),
  ],
  [
    'diacritics and case',
    upload('BEYONCÉ - Halo (Official Video)', 'Beyoncé', 261),
    upload('Beyonce - Halo', 'Beyonce - Topic', 262),
  ],
  [
    'curly apostrophes and en dash',
    upload('Guns N’ Roses – Sweet Child O’ Mine', 'Guns N’ Roses', 356),
    upload(
      "Guns N' Roses - Sweet Child O' Mine (Official Lyric Video)",
      'GunsNRosesVEVO',
      357,
    ),
  ],
  [
    'ampersand artist and and artist',
    upload(
      'Simon & Garfunkel - The Sound of Silence',
      'Simon & Garfunkel',
      185,
    ),
    upload(
      'Simon and Garfunkel - The Sound of Silence (Audio)',
      'SimonAndGarfunkelVEVO',
      185,
    ),
  ],
  [
    'track with trailing lyrics word',
    upload('Coldplay - Yellow Lyrics', 'Coldplay - Topic', 270),
    upload('Coldplay - Yellow (Official Video)', 'Coldplay', 269),
  ],
  [
    'artist, Topic and VEVO channels of one artist',
    upload('Adele - Hello', 'Adele', 295),
    upload('Hello', 'Adele - Topic', 295),
  ],
  [
    'AdeleVEVO against the artist channel',
    upload('Hello', 'AdeleVEVO', 295),
    upload('Adele - Hello', 'Adele', 295),
  ],
  [
    'Records suffix on the channel',
    upload('Adele - Hello', 'Adele Records', 295),
    upload('Adele - Hello', 'Adele - Topic', 295),
  ],
  [
    'identical unknown subtitle on both uploads',
    upload('Artist - Hello (Goodbye)', 'Artist', 240),
    upload('Artist - Hello [Goodbye] (Official Audio)', 'Artist - Topic', 240),
  ],
  [
    'credit tail without a marker is dropped',
    upload('Daft Punk - Get Lucky ft. Pharrell Williams', 'Daft Punk', 240),
    upload('Daft Punk - Get Lucky', 'DaftPunkVEVO', 240),
  ],
  [
    'original mix is not a version marker',
    upload('Avicii - Levels (Original Mix)', 'Avicii', 199),
    upload('Avicii - Levels', 'Avicii - Topic', 199),
  ],
  [
    'same remix named identically',
    upload('Adele - Hello (Calvin Harris Remix)', 'Adele', 240),
    upload('Hello (Calvin Harris Remix)', 'Adele - Topic', 241),
  ],
  [
    'same live recording named identically',
    upload('Oasis - Wonderwall (Live at Wembley)', 'Oasis', 260),
    upload(
      'Oasis - Wonderwall [Live at Wembley] (Official Audio)',
      'Oasis - Topic',
      261,
    ),
  ],
  [
    'track that contains the word live in both',
    upload('Oasis - Live Forever (Remastered)', 'Oasis', 276),
    upload('Live Forever', 'Oasis - Topic', 276),
  ],
  [
    'multi-artist credit, channel of one of the artists',
    upload('Calvin Harris & Dua Lipa - One Kiss', 'Calvin Harris', 215),
    upload('Calvin Harris, Dua Lipa - One Kiss', 'Dua Lipa - Topic', 215),
  ],
  [
    'channel named after the featured artist',
    upload('Calvin Harris - One Kiss (feat. Dua Lipa)', 'Dua Lipa', 215),
    upload('Calvin Harris - One Kiss', 'Calvin Harris - Topic', 215),
  ],
  [
    'multi-artist credit in reverse order on the other channel',
    upload('Calvin Harris & Dua Lipa - One Kiss', 'Calvin Harris', 215),
    upload('Dua Lipa & Calvin Harris - One Kiss', 'Dua Lipa - Topic', 215),
  ],
  [
    'Official and Music suffixes together',
    upload('Adele - Hello', 'Adele Official Music', 295),
    upload('Hello', 'Adele - Topic', 295),
  ],
  [
    'non-latin title, identical track',
    upload('YOASOBI - 夜に駆ける (Official Music Video)', 'YOASOBI', 261),
    upload('夜に駆ける', 'YOASOBI - Topic', 262),
  ],
  [
    'noise-only track preserved before true trailing metadata segments',
    upload('Adele - Song - Official Audio - HD', 'Adele', 295),
    upload('Song (Official Video) | Official Audio', 'Adele - Topic', 295),
  ],
  [
    'noise-only track preserved before a version segment',
    upload('Adele - Song - Live', 'Adele', 295),
    upload('Song (Live)', 'Adele - Topic', 295),
  ],
  [
    'a real track named after its artist is not uncertain',
    upload('Adele - Adele', 'Adele', 295),
    upload('Adele', 'Adele - Topic', 295),
  ],
  [
    'duration inside the 3 percent window on long songs',
    upload('Pink Floyd - Echoes (Remastered)', 'Pink Floyd', 1400),
    upload('Pink Floyd - Echoes', 'Pink Floyd - Topic', 1430),
  ],
  [
    'identical video id wins over everything',
    upload('Anything', 'Whoever', 1, 'same-id-001'),
    upload('Completely other title (Live)', 'Someone else', 900, 'same-id-001'),
  ],
];

const separate: Row[] = [
  [
    'live vs studio',
    upload('Oasis - Wonderwall (Live)', 'Oasis', 260),
    upload('Oasis - Wonderwall', 'Oasis', 260),
  ],
  [
    'different live recordings',
    upload('Oasis - Wonderwall (Live at Wembley)', 'Oasis', 260),
    upload('Oasis - Wonderwall (Live at Knebworth)', 'Oasis', 260),
  ],
  [
    'remix vs original',
    upload('Adele - Hello (Remix)', 'Adele', 240),
    upload('Adele - Hello', 'Adele', 240),
  ],
  [
    'two different remixers',
    upload('Adele - Hello (Calvin Harris Remix)', 'Adele', 240),
    upload('Adele - Hello (Tiesto Remix)', 'Adele', 240),
  ],
  [
    'rmx abbreviation vs studio',
    upload('Artist - Song RMX', 'Artist', 200),
    upload('Artist - Song', 'Artist', 200),
  ],
  [
    'cover vs original',
    upload('Hello (Adele cover)', 'Some Singer', 245),
    upload('Adele - Hello', 'Adele', 245),
  ],
  [
    'slowed vs original',
    upload('Glass Animals - Heat Waves (Slowed)', 'Glass Animals', 238),
    upload('Glass Animals - Heat Waves', 'Glass Animals', 238),
  ],
  [
    'slowed and reverb vs original',
    upload('Glass Animals - Heat Waves (Slowed + Reverb)', 'Chill Vibes', 238),
    upload('Glass Animals - Heat Waves', 'Glass Animals', 238),
  ],
  [
    'sped up vs original',
    upload('Doja Cat - Say So (Sped Up)', 'Doja Cat', 238),
    upload('Doja Cat - Say So', 'Doja Cat', 238),
  ],
  [
    'nightcore vs original (same duration)',
    upload('Nightcore - Counting Stars', 'Nightcore Hub', 257),
    upload('OneRepublic - Counting Stars', 'OneRepublic', 257),
  ],
  [
    'nightcore channel only',
    upload('OneRepublic - Counting Stars', 'NightcoreReality Nightcore', 257),
    upload('OneRepublic - Counting Stars', 'OneRepublic', 257),
  ],
  [
    'acoustic vs studio',
    upload('Ed Sheeran - Perfect (Acoustic)', 'Ed Sheeran', 260),
    upload('Ed Sheeran - Perfect', 'Ed Sheeran', 260),
  ],
  [
    'instrumental vs vocal',
    upload('Eminem - Lose Yourself (Instrumental)', 'Eminem', 326),
    upload('Eminem - Lose Yourself', 'Eminem', 326),
  ],
  [
    'karaoke vs original',
    upload('Queen - Bohemian Rhapsody (Karaoke Version)', 'Sing King', 355),
    upload('Queen - Bohemian Rhapsody', 'Queen', 355),
  ],
  [
    'taylors version vs original',
    upload("Taylor Swift - Love Story (Taylor's Version)", 'Taylor Swift', 235),
    upload('Taylor Swift - Love Story', 'Taylor Swift', 235),
  ],
  [
    'radio edit vs album version',
    upload('Calvin Harris - Summer (Radio Edit)', 'Calvin Harris', 222),
    upload('Calvin Harris - Summer', 'Calvin Harris', 222),
  ],
  [
    'extended mix vs original',
    upload('Avicii - Levels (Extended Mix)', 'Avicii', 199),
    upload('Avicii - Levels', 'Avicii', 199),
  ],
  [
    'unplugged vs studio',
    upload('Nirvana - About a Girl (Unplugged)', 'Nirvana', 217),
    upload('Nirvana - About a Girl', 'Nirvana', 217),
  ],
  [
    'part two vs part one',
    upload('Artist - Song (Part 2)', 'Artist', 200),
    upload('Artist - Song (Part 1)', 'Artist', 200),
  ],
  [
    'same title different artist (Hello)',
    upload('Adele - Hello', 'Adele', 295),
    upload('Lionel Richie - Hello', 'Lionel Richie', 295),
  ],
  [
    'same title different artist via channel',
    upload('Hello', 'Adele - Topic', 295),
    upload('Hello', 'Lionel Richie - Topic', 295),
  ],
  [
    'same artist different track',
    upload('Adele - Hello', 'Adele', 295),
    upload('Adele - Someone Like You', 'Adele', 295),
  ],
  [
    'noise-only tracks Song and Music are different tracks',
    upload('Adele - Song', 'Adele - Topic', 295),
    upload('Adele - Music', 'Adele - Topic', 295),
  ],
  [
    'noise-only track Song is not the artist-named track Adele',
    upload('Adele - Song', 'Adele - Topic', 295),
    upload('Adele - Adele', 'Adele - Topic', 295),
  ],
  [
    'noise-only track Song is not the bare artist name',
    upload('Adele - Song', 'Adele - Topic', 295),
    upload('Adele', 'Adele - Topic', 295),
  ],
  [
    'similar but not equal track names',
    upload('Adele - Hello', 'Adele', 295),
    upload('Adele - Hello Adele', 'Adele', 295),
  ],
  [
    'track names differing by one word',
    upload('Ed Sheeran - Shape of You', 'Ed Sheeran', 234),
    upload('Ed Sheeran - Shape of Water', 'Ed Sheeran', 234),
  ],
  [
    'with is part of the track name, not a credit',
    upload('Artist - Stuck With Me', 'Artist', 200),
    upload('Artist - Stuck With U', 'Artist', 200),
  ],
  [
    'duration over the 4 second guard',
    upload('Adele - Hello', 'Adele', 295),
    upload('Adele - Hello (Lyrics)', 'Lyrics Hub', 310),
  ],
  [
    'duration over 3 percent on a long song',
    upload('Pink Floyd - Echoes', 'Pink Floyd', 1400),
    upload('Pink Floyd - Echoes (Official Audio)', 'Pink Floyd', 1460),
  ],
  [
    'unknown duration never links',
    upload('Adele - Hello', 'Adele', 0),
    upload('Adele - Hello (Lyrics)', 'Adele', 295),
  ],
  [
    'no artist information on either side',
    upload('Hello', 'Music', 295),
    upload('Hello (Audio)', 'Official', 295),
  ],
  [
    'artists share only one of four tokens',
    upload(
      'The Black Eyed Peas Crew - Pump It',
      'The Black Eyed Peas Crew',
      213,
    ),
    upload(
      'Peas Orchestra Band Live - Pump It',
      'Peas Orchestra Band Live',
      213,
    ),
  ],
  [
    'mashup vs original',
    upload('Artist A x Artist B - Song (Mashup)', 'DJ Blend', 200),
    upload('Artist A - Song', 'Artist A', 200),
  ],
  [
    'piano version vs original',
    upload('Coldplay - Clocks (Piano Version)', 'Coldplay', 307),
    upload('Coldplay - Clocks', 'Coldplay', 307),
  ],
  [
    'live recording with credit tail vs studio (ft.)',
    upload(
      'Daft Punk - Get Lucky ft. Pharrell Williams live',
      'Daft Punk',
      240,
    ),
    upload('Daft Punk - Get Lucky', 'Daft Punk - Topic', 240),
  ],
  [
    'live recording with credit tail vs studio (feat.)',
    upload(
      'Daft Punk - Get Lucky feat. Pharrell Williams live',
      'Daft Punk',
      240,
    ),
    upload('Daft Punk - Get Lucky', 'DaftPunkVEVO', 240),
  ],
  [
    'live recording with credit tail vs studio (featuring)',
    upload(
      'Daft Punk - Get Lucky featuring Pharrell Williams live',
      'Daft Punk',
      240,
    ),
    upload('Daft Punk - Get Lucky', 'Daft Punk', 240),
  ],
  [
    'remix hidden behind a bracketed credit',
    upload(
      'Daft Punk - Get Lucky (ft. Pharrell Williams remix)',
      'Daft Punk',
      240,
    ),
    upload('Daft Punk - Get Lucky', 'Daft Punk', 240),
  ],
  [
    'artists AB and A B are different artists',
    upload('AB - Hello', 'AB', 240),
    upload('A B - Hello', 'A B', 240),
  ],
  [
    'different bracketed subtitles',
    upload('Artist - Hello (Goodbye)', 'Artist', 240),
    upload('Artist - Hello (Again)', 'Artist', 240),
  ],
  [
    'bracketed subtitle on one upload only',
    upload('Artist - Hello (Goodbye)', 'Artist', 240),
    upload('Artist - Hello', 'Artist - Topic', 240),
  ],
  [
    'different pipe subtitles',
    upload('Artist - Hello | Goodbye', 'Artist', 240),
    upload('Artist - Hello | Again', 'Artist', 240),
  ],
  [
    'different dash subtitles',
    upload('Artist - Hello - Goodbye', 'Artist', 240),
    upload('Artist - Hello - Again', 'Artist', 240),
  ],
  [
    'Intro on two different albums',
    upload('Artist - Intro [Album One]', 'Artist', 60),
    upload('Artist - Intro [Album Two]', 'Artist', 60),
  ],
  [
    'Untitled on two different albums',
    upload('Artist - Untitled (Album One)', 'Artist', 180),
    upload('Artist - Untitled (Album Two)', 'Artist', 180),
  ],
  [
    'Track 1 on two different albums',
    upload('Artist - Track 1 | Album One', 'Artist', 180),
    upload('Artist - Track 1 | Album Two', 'Artist', 180),
  ],
  [
    'karaoke channel without any marker (Sing King)',
    upload('Adele - Hello', 'Sing King', 295),
    upload('Adele - Hello', 'Adele', 295),
  ],
  [
    'lyric channel is not the artist',
    upload('Adele - Hello (Lyrics)', 'Lyrical Lemon', 295),
    upload('Adele - Hello', 'Adele - Topic', 295),
  ],
  [
    'fan channel named after the artist (Adele Fan)',
    upload('Adele - Hello', 'Adele Fan', 295),
    upload('Hello', 'Adele - Topic', 295),
  ],
  [
    'lyrics channel named after the artist (Adele Lyrics)',
    upload('Adele - Hello (Lyrics)', 'Adele Lyrics', 295),
    upload('Adele - Hello', 'Adele', 295),
  ],
  [
    'denylisted channel with the artist as its only other token',
    upload('Adele - Hello', 'Adele Covers', 295),
    upload('Adele - Hello', 'Adele - Topic', 295),
  ],
  [
    'CamelCase lyrics channel',
    upload('Adele - Hello', 'AdeleLyrics', 295),
    upload('Adele - Hello', 'Adele', 295),
  ],
  [
    'third-party channel without an artist in the title (Hello vs Hello (Audio))',
    upload('Hello', 'Sing King', 295),
    upload('Hello (Audio)', 'Sing King', 295),
  ],
  [
    'artist-named channel that is not Topic or VEVO, no artist in the title',
    upload('Hello', 'Adele', 295),
    upload('Hello', 'Adele - Topic', 295),
  ],
  [
    'two uploads of one unknown-artist channel',
    upload('Hello', 'Some Channel', 295),
    upload('Hello (Official Audio)', 'Some Channel', 295),
  ],
  [
    'accepted false negative: channel tokens beyond the artist credit',
    upload('Weeknd - Blinding Lights', 'The Weeknd - Topic', 200),
    upload('The Weeknd - Blinding Lights', 'The Weeknd', 200),
  ],
  [
    'two third-party channels never link each other',
    upload('Adele - Hello', 'Sing King', 295),
    upload('Adele - Hello', '7clouds', 295),
  ],
  [
    'fan upload that only lists the artist in the title',
    upload('Lyrics Hub - Hello', 'Lyrics Hub', 295),
    upload('Hello', 'Adele - Topic', 295),
  ],
  [
    'accepted false negative: "with" credit is not parsed',
    upload('Daft Punk - Get Lucky with Pharrell Williams', 'Daft Punk', 240),
    upload('Daft Punk - Get Lucky', 'Daft Punk', 240),
  ],
  [
    'accepted false negative: unbracketed Remastered 2011',
    upload('Queen - Bohemian Rhapsody Remastered 2011', 'Queen', 355),
    upload('Queen - Bohemian Rhapsody', 'Queen', 355),
  ],
  [
    'artist that is a prefix of the other artist (Pink vs Pink Floyd)',
    upload('Pink - Time', 'Pink', 402),
    upload('Pink Floyd - Time', 'Pink Floyd', 402),
  ],
  [
    'pipe-only titles whose track hides behind a noise word',
    upload('Adele | Song', 'Adele - Topic', 295),
    upload('Adele | Music', 'Adele - Topic', 295),
  ],
  [
    'bracket-only titles whose track hides behind a noise word',
    upload('Adele (Song)', 'Adele - Topic', 295),
    upload('Adele (Music)', 'Adele - Topic', 295),
  ],
  [
    'accepted false negative: an uncertain pipe title never links an artist-named track',
    upload('Adele | Song', 'Adele - Topic', 295),
    upload('Adele - Adele', 'Adele - Topic', 295),
  ],
  [
    'accepted false negative: one-sided featured credit (A & B vs A feat. B)',
    upload('Pink & Nate - Just Give Me a Reason', 'Pink', 242),
    upload('Pink - Just Give Me a Reason (feat. Nate)', 'Pink - Topic', 242),
  ],
  [
    'accepted false negative: a channel named only by a suffix word (Music - Topic)',
    upload('Music', 'Music - Topic', 200),
    upload('Music', 'Music - Topic', 200),
  ],
];

describe('isSameSong', () => {
  it('has at least thirty real-world style pairs', () => {
    expect(linked.length + separate.length).toBeGreaterThanOrEqual(30);
  });

  it.each(linked)('links: %s', (_label, a, b) => {
    expect(isSameSong(a, b)).toBe(true);
    expect(isSameSong(b, a)).toBe(true);
  });

  it.each(separate)('keeps apart: %s', (_label, a, b) => {
    expect(isSameSong(a, b)).toBe(false);
    expect(isSameSong(b, a)).toBe(false);
  });

  it.each(['Song', 'Music', 'Audio', 'Video', 'Official', 'Lyrics'])(
    'preserves the noise-only track %s across artist and Topic uploads',
    (track) => {
      const a = upload(`Adele - ${track}`, 'Adele', 295);
      const b = upload(track, 'Adele - Topic', 295);
      expect(isSameSong(a, b)).toBe(true);
      expect(isSameSong(b, a)).toBe(true);
    },
  );

  it.each([
    'Adele - ',
    'Adele - (Official Audio)',
    'Adele - !!!',
    'Adele -  - Official Audio',
    'Adele - Adele Lyrics',
    'Adele - Adele ft. Someone',
  ])(
    'never invents an artist-named track from the uncertain title %s',
    (title) => {
      const a = upload(title, 'Adele - Topic', 295);
      const b = upload('Adele', 'Adele - Topic', 295);
      expect(isSameSong(a, b)).toBe(false);
      expect(isSameSong(b, a)).toBe(false);
      expect(isSameSong(a, { ...b, videoId: a.videoId })).toBe(true);
    },
  );

  it('never links a track that only survived noise stripping of a pipe or bracket segment', () => {
    const uncertain = [
      ['Adele | Song', 'Adele - Topic'],
      ['Adele | Music', 'Adele - Topic'],
      ['Adele (Song)', 'Adele - Topic'],
      ['Adele (Music)', 'Adele - Topic'],
      ['Adele | Hello', 'Adele - Topic'],
    ] as const;
    for (const [title, channel] of uncertain) {
      const a = upload(title, channel, 295);
      const b = upload('Adele', 'Adele - Topic', 295);
      expect(isSameSong(a, b)).toBe(false);
      expect(isSameSong(b, a)).toBe(false);
      expect(isSameSong(a, { ...b, videoId: a.videoId })).toBe(true);
    }
    const pipe = upload('Adele | Song', 'Adele - Topic', 295);
    const bracket = upload('Adele (Song)', 'Adele - Topic', 295);
    expect(isSameSong(pipe, bracket)).toBe(false);
  });

  it('keeps an identical videoId linked even on a denylisted channel', () => {
    const a = upload('Hello', 'Sing King', 295, 'sameVideo01');
    const b = upload('Hello (Lyrics)', 'Adele Fan', 0, 'sameVideo01');
    expect(isSameSong(a, b)).toBe(true);
    expect(isSameSong(b, a)).toBe(true);
  });
});

describe('groupSameSongs', () => {
  const official = upload('Adele - Hello (Official Video)', 'Adele', 367);
  const topic = upload('Hello', 'Adele - Topic', 367);
  const lyrics = upload('Adele - Hello (Lyrics)', 'AdeleVEVO', 366);
  const richie = upload('Lionel Richie - Hello', 'Lionel Richie', 367);
  const live = upload('Adele - Hello (Live)', 'Adele', 367);

  it('groups by actual pairs and keeps indices ascending', () => {
    expect(groupSameSongs([official, richie, topic, live, lyrics])).toEqual([
      [0, 2, 4],
      [1],
      [3],
    ]);
  });

  it('chains through a middle upload without requiring every pair to match', () => {
    const a = upload('Artist - Song', 'Artist', 200);
    const b = upload('Artist - Song', 'Artist', 205);
    const c = upload('Artist - Song', 'Artist', 210);
    expect(isSameSong(a, c)).toBe(false);
    expect(groupSameSongs([a, b, c])).toEqual([[0, 1, 2]]);
  });

  it('does not group distinct noise-only and artist-named tracks', () => {
    const songs = [
      'Adele - Song',
      'Adele - Music',
      'Adele - Adele',
      'Adele',
    ].map((title) => upload(title, 'Adele - Topic', 295));
    expect(groupSameSongs(songs)).toEqual([[0], [1], [2, 3]]);
  });

  it('is empty for no input and singleton for one', () => {
    expect(groupSameSongs([])).toEqual([]);
    expect(groupSameSongs([official])).toEqual([[0]]);
  });
});
