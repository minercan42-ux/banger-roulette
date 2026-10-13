import { OEmbedResponseSchema } from '../shared/protocol';
import { VideoId } from '../shared/primitives';

export interface OEmbedMetadata {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
}

/** Raised for every non-successful or malformed `/api/oembed` answer. */
export class OEmbedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OEmbedError';
  }
}

/**
 * Loads normalized metadata (FR-21) from the same-origin proxy. Duration is
 * deliberately absent: it only comes from a real playing preview (FR-22).
 */
export async function fetchMetadata(
  videoId: string,
  signal?: AbortSignal,
): Promise<OEmbedMetadata> {
  const response = await fetch(
    `/api/oembed?videoId=${encodeURIComponent(videoId)}`,
    { signal, headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new OEmbedError(
      response.status,
      `oEmbed proxy responded with ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OEmbedError(502, 'oEmbed proxy returned invalid JSON');
  }
  const record =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const oembed = OEmbedResponseSchema.safeParse({
    title: record.title,
    channel: record.channel,
    thumbnail: record.thumbnail,
  });
  const id = VideoId.safeParse(record.videoId);
  if (!oembed.success || !id.success || id.data !== videoId) {
    throw new OEmbedError(502, 'oEmbed proxy returned unexpected metadata');
  }
  return { videoId: id.data, ...oembed.data };
}
