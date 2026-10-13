import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fetchMetadata, OEmbedError } from './metadata';

const VIDEO_ID = 'M7lc1UVf-VE';
const THUMBNAIL = `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`;
const EXPECTED_URL = `/api/oembed?videoId=${VIDEO_ID}`;

type FetchMock = (input: string, init?: RequestInit) => Promise<Response>;

function stubFetch(): Mock<FetchMock> {
  const mock = vi.fn<FetchMock>();
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMetadata', () => {
  it('loads normalized metadata from the same-origin proxy', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(
      Response.json({
        videoId: VIDEO_ID,
        title: 'Song',
        channel: 'Channel',
        thumbnail: THUMBNAIL,
        html: '<iframe></iframe>',
      }),
    );

    await expect(fetchMetadata(VIDEO_ID)).resolves.toEqual({
      videoId: VIDEO_ID,
      title: 'Song',
      channel: 'Channel',
      thumbnail: THUMBNAIL,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe(EXPECTED_URL);
  });

  it('forwards the abort signal to the request', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(
      Response.json({
        videoId: VIDEO_ID,
        title: 'Song',
        channel: 'Channel',
        thumbnail: THUMBNAIL,
      }),
    );
    const controller = new AbortController();

    await fetchMetadata(VIDEO_ID, controller.signal);

    expect(mock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('throws a transparent error for a non-successful response', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(new Response('missing', { status: 404 }));

    const error = await fetchMetadata(VIDEO_ID).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(OEmbedError);
    expect((error as OEmbedError).status).toBe(404);
  });

  it('rejects a response whose video id differs from the request', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(
      Response.json({
        videoId: 'dQw4w9WgXcQ',
        title: 'Song',
        channel: 'Channel',
        thumbnail: THUMBNAIL,
      }),
    );
    await expect(fetchMetadata(VIDEO_ID)).rejects.toBeInstanceOf(OEmbedError);
  });

  it('rejects an invalid JSON body', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(fetchMetadata(VIDEO_ID)).rejects.toBeInstanceOf(OEmbedError);
  });
});
