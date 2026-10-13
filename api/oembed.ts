import { VideoId } from '../src/shared/primitives';
import { OEmbedResponseSchema } from '../src/shared/protocol';

/**
 * Fixed upstream endpoint. The client can never influence the target beyond the
 * validated video id, so this function is not an open proxy (FR-21).
 */
const YOUTUBE_OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';
const YOUTUBE_WATCH_URL = 'https://www.youtube.com/watch?v=';
export const OEMBED_TIMEOUT_MS = 5_000;

function jsonError(
  status: number,
  code: string,
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(
    { error: code },
    {
      status,
      headers: { 'Cache-Control': 'no-store', ...extraHeaders },
    },
  );
}

/**
 * Same-origin YouTube oEmbed proxy. Web-standard Vercel handler: only GET is
 * accepted, exactly one valid `videoId` is allowed, the upstream URL is fixed
 * and redirects are refused. Only title, channel, thumbnail and the echoed
 * video id leave the function; the upstream `html` embed code never does.
 */
export async function GET(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonError(405, 'METHOD_NOT_ALLOWED', { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const ids = url.searchParams.getAll('videoId');
  if (ids.length !== 1) {
    return jsonError(400, 'INVALID_VIDEO_ID');
  }
  const parsedId = VideoId.safeParse(ids[0]);
  if (!parsedId.success) {
    return jsonError(400, 'INVALID_VIDEO_ID');
  }
  const videoId = parsedId.data;
  const target = `${YOUTUBE_OEMBED_ENDPOINT}?url=${encodeURIComponent(
    `${YOUTUBE_WATCH_URL}${videoId}`,
  )}&format=json`;
  if (request.signal.aborted) {
    return jsonError(504, 'UPSTREAM_TIMEOUT');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS);
  const abortFromRequest = () => controller.abort();
  request.signal.addEventListener('abort', abortFromRequest, { once: true });

  try {
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        signal: controller.signal,
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
    } catch {
      return jsonError(
        controller.signal.aborted ? 504 : 502,
        controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      );
    }

    if (!upstream.ok) {
      return upstream.status === 404
        ? jsonError(404, 'NOT_FOUND')
        : jsonError(502, 'UPSTREAM_ERROR');
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      return jsonError(
        controller.signal.aborted ? 504 : 502,
        controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      );
    }

    const record =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const metadata = OEmbedResponseSchema.safeParse({
      title: record.title,
      channel: record.author_name,
      thumbnail: record.thumbnail_url,
    });
    if (!metadata.success) {
      return jsonError(502, 'UPSTREAM_ERROR');
    }

    return Response.json(
      { videoId, ...metadata.data },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abortFromRequest);
  }
}
