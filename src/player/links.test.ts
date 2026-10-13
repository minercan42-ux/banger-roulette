import { describe, expect, it } from 'vitest';
import { parseYouTubeLink } from './links';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeLink', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, 0],
    [`https://youtube.com/watch?v=${ID}`, 0],
    [`http://www.youtube.com/watch?v=${ID}`, 0],
    [`https://m.youtube.com/watch?v=${ID}`, 0],
    [`https://music.youtube.com/watch?v=${ID}`, 0],
    [`https://www.youtube.com/watch?v=${ID}&list=PLabc&index=2`, 0],
    [`https://www.youtube.com/watch?v=${ID}&t=90`, 90],
    [`https://www.youtube.com/watch?v=${ID}&t=90s`, 90],
    [`https://www.youtube.com/watch?v=${ID}&t=1m30s`, 90],
    [`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`, 3723],
    [`https://www.youtube.com/watch?v=${ID}&t=1m`, 60],
    [`https://youtu.be/${ID}`, 0],
    [`https://youtu.be/${ID}?t=30`, 30],
    [`https://www.youtube.com/shorts/${ID}`, 0],
    [`https://music.youtube.com/shorts/${ID}?t=12`, 12],
    [`  https://www.youtube.com/watch?v=${ID}  `, 0],
  ])('accepts %s with start %i', (input: string, startSeconds: number) => {
    expect(parseYouTubeLink(input)).toEqual({ videoId: ID, startSeconds });
  });

  it.each([
    'https://vimeo.com/123456789',
    'https://youtube.example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=M7lc1UVf-VE',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ!',
    'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://youtu.be/',
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'ftp://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'youtu.be/dQw4w9WgXcQ',
    '',
    '   ',
    'not a url',
    `https://www.youtube.com/watch?v=${ID}&t=abc`,
    `https://www.youtube.com/watch?v=${ID}&t=-5`,
    `https://www.youtube.com/watch?v=${ID}&t=1m30`,
    `https://www.youtube.com/watch?v=${ID}&t=1x`,
    `https://youtu.be/${ID}?t=${'9'.repeat(400)}`,
    `https://youtu.be/${ID}?t=9007199254740992`,
    `https://youtu.be/${ID}?t=${'9'.repeat(400)}h2m3s`,
  ])('rejects %s', (input: string) => {
    expect(parseYouTubeLink(input)).toBeNull();
  });

  it('treats a normalized default https port as no port', () => {
    expect(
      parseYouTubeLink(`https://www.youtube.com:443/watch?v=${ID}`),
    ).toEqual({ videoId: ID, startSeconds: 0 });
  });
});
