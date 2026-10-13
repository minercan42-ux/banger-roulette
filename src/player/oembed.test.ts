import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GET } from '../../api/oembed';

const VIDEO_ID = 'M7lc1UVf-VE';
const THUMBNAIL = `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`;
const ENDPOINT = 'https://www.youtube.com/oembed';
const WATCH = 'https://www.youtube.com/watch?v=';
const EXPECTED_URL = `${ENDPOINT}?url=${encodeURIComponent(`${WATCH}${VIDEO_ID}`)}&format=json`;

type FetchMock = (input: string, init: RequestInit) => Promise<Response>;

function stubFetch(): Mock<FetchMock> {
  const mock = vi.fn<FetchMock>();
  vi.stubGlobal('fetch', mock);
  return mock;
}

function request(query: string, method = 'GET'): Request {
  return new Request(`http://localhost/api/oembed?${query}`, { method });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/oembed', () => {
  it('returns only normalized metadata and never the embed html', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(
      Response.json({
        title: 'Song',
        author_name: 'Channel',
        thumbnail_url: THUMBNAIL,
        html: '<iframe src="https://www.youtube.com/embed/x"></iframe>',
      }),
    );

    const response = await GET(request(`videoId=${VIDEO_ID}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      videoId: VIDEO_ID,
      title: 'Song',
      channel: 'Channel',
      thumbnail: THUMBNAIL,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mock.mock.calls[0];
    expect(calledUrl).toBe(EXPECTED_URL);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('ignores extra query parameters so no arbitrary target is reachable', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(
      Response.json({
        title: 'Song',
        author_name: 'Channel',
        thumbnail_url: THUMBNAIL,
      }),
    );

    const response = await GET(
      request(
        `videoId=${VIDEO_ID}&url=${encodeURIComponent('https://evil.example/x')}&format=text`,
      ),
    );

    expect(response.status).toBe(200);
    const [calledUrl] = mock.mock.calls[0];
    expect(calledUrl).toBe(EXPECTED_URL);
    expect(calledUrl).not.toContain('evil');
  });

  it.each([
    '',
    'videoId=',
    'videoId=short',
    `videoId=${VIDEO_ID}&videoId=M7lc1UVf-VE`,
    'other=1',
  ])('rejects an invalid videoId query: %s', async (query: string) => {
    const mock = stubFetch();
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'INVALID_VIDEO_ID' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects every non-GET method', async () => {
    const mock = stubFetch();
    const response = await GET(request(`videoId=${VIDEO_ID}`, 'POST'));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(await response.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('maps an upstream 404 to a controlled 404', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(new Response('nope', { status: 404 }));
    const response = await GET(request(`videoId=${VIDEO_ID}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('maps other upstream failures to a 502', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(new Response('boom', { status: 500 }));
    const response = await GET(request(`videoId=${VIDEO_ID}`));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'UPSTREAM_ERROR' });
  });

  it('rejects an unparseable upstream body', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(new Response('not json', { status: 200 }));
    const response = await GET(request(`videoId=${VIDEO_ID}`));
    expect(response.status).toBe(502);
  });

  it.each([
    { title: 'Song', thumbnail_url: THUMBNAIL },
    { title: 'Song', author_name: 'Channel' },
    {
      title: 'Song',
      author_name: 'Channel',
      thumbnail_url: 'https://example.com/x.jpg',
    },
    { title: '', author_name: 'Channel', thumbnail_url: THUMBNAIL },
  ])(
    'rejects metadata that fails schema validation',
    async (body: Record<string, unknown>) => {
      const mock = stubFetch();
      mock.mockResolvedValue(Response.json(body));
      const response = await GET(request(`videoId=${VIDEO_ID}`));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'UPSTREAM_ERROR' });
    },
  );

  it('cancels an in-flight upstream request when the caller aborts', async () => {
    const mock = stubFetch();
    mock.mockImplementation((_input, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
      return promise;
    });
    const controller = new AbortController();
    const pending = GET(
      new Request(`http://localhost/api/oembed?videoId=${VIDEO_ID}`, {
        signal: controller.signal,
      }),
    );
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'UPSTREAM_TIMEOUT' });
  });

  it('does not start upstream work for an already cancelled request', async () => {
    const mock = stubFetch();
    const controller = new AbortController();
    controller.abort();
    const response = await GET(
      new Request(`http://localhost/api/oembed?videoId=${VIDEO_ID}`, {
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(504);
    expect(mock).not.toHaveBeenCalled();
  });

  it('reports network failures as upstream errors rather than timeouts', async () => {
    const mock = stubFetch();
    mock.mockRejectedValue(new TypeError('connection failed'));
    const response = await GET(request(`videoId=${VIDEO_ID}`));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'UPSTREAM_ERROR' });
  });
});
