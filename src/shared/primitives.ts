import { z } from 'zod';

export const Id = z.uuid();
export const Int = z.number().int().nonnegative();
export const Time = Int;
export const Seconds = z.number().finite().nonnegative();
export const VideoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const RoomCode = z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
export const Nickname = z.string().trim().min(1).max(20);
export const GenreSchema = z.strictObject({
  id: z.string().min(1).max(80),
  de: z.string().trim().min(1).max(80),
  en: z.string().trim().min(1).max(80),
});
export type Genre = z.infer<typeof GenreSchema>;
export const Thumbnail = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'i.ytimg.com' &&
        !url.username &&
        !url.password &&
        !url.port
      );
    } catch {
      return false;
    }
  }, 'Expected HTTPS i.ytimg.com thumbnail');
export const MediaSchema = z
  .strictObject({
    videoId: VideoId,
    title: z.string().min(1).max(500),
    channel: z.string().min(1).max(200),
    thumbnail: Thumbnail,
    durationSeconds: z.number().finite().positive(),
    startSeconds: Seconds,
  })
  .refine(
    (media) => media.startSeconds < media.durationSeconds,
    'Start must precede video end',
  );
export type Media = z.infer<typeof MediaSchema>;
export function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}
export const Ids = z.array(Id).max(10).refine(unique, 'Duplicate IDs');
export const VideoIds = z
  .array(VideoId)
  .max(10)
  .refine(unique, 'Duplicate video IDs');
export function nicknameKey(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}
