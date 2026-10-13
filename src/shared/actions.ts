import { z } from 'zod';
import {
  Id,
  Int,
  MediaSchema,
  Nickname,
  Time,
  VideoId,
  VideoIds,
} from './primitives';
import { RequiredSettingsSchema } from './settings';

export const ClientActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('JOIN'), nickname: Nickname }),
  z.strictObject({ type: z.literal('LEAVE') }),
  z.strictObject({ type: z.literal('SOUND_STATUS'), unlocked: z.boolean() }),
  z.strictObject({
    type: z.literal('SET_SETTINGS'),
    settings: RequiredSettingsSchema,
  }),
  z.strictObject({ type: z.literal('KICK'), playerId: Id }),
  z.strictObject({ type: z.literal('START_GAME') }),
  z.strictObject({ type: z.literal('SUBMIT_SONG'), media: MediaSchema }),
  z.strictObject({ type: z.literal('REMOVE_SUBMISSION') }),
  z.strictObject({ type: z.literal('FINISH_SUBMISSION') }),
  z.strictObject({ type: z.literal('SET_RANKING'), ranking: VideoIds }),
  z.strictObject({ type: z.literal('FINISH_VOTING') }),
  z.strictObject({
    type: z.literal('SET_GENRE_FAIL'),
    videoId: VideoId,
    flagged: z.boolean(),
  }),
  z.strictObject({ type: z.literal('ADVANCE') }),
  z.strictObject({ type: z.literal('PAUSE') }),
  z.strictObject({ type: z.literal('RESUME'), forceBelowMinimum: z.boolean() }),
  z.strictObject({ type: z.literal('END_GAME') }),
  z.strictObject({ type: z.literal('REMATCH') }),
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;
export const EngineActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('COMMAND'),
    actorId: Id,
    connectionId: Id,
    commandId: Id,
    at: Time,
    gameNumber: Int,
    roundNumber: Int,
    command: ClientActionSchema,
  }),
  z.strictObject({ type: z.literal('DEADLINE'), at: Time }),
  z.strictObject({
    type: z.literal('PRESENCE_SYNC'),
    at: Time,
    connectionIds: z
      .array(Id)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Duplicate connections',
      ),
  }),
  z.strictObject({
    type: z.literal('HOST_CHANGED'),
    at: Time,
    hostId: Id,
    hostEpoch: Int,
    hostBaseVersion: Int,
    connectionIds: z
      .array(Id)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Duplicate connections',
      ),
  }),
]);
export type EngineAction = z.infer<typeof EngineActionSchema>;
