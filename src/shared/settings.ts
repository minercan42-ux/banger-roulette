import { z } from 'zod';
import { GenreSchema, unique } from './primitives';

export const GenreModeSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('roulette') }),
  z.strictObject({
    mode: z.literal('custom'),
    items: z
      .array(GenreSchema)
      .min(2)
      .max(50)
      .refine(
        (items) => unique(items.map((item) => item.id)),
        'Duplicate genres',
      ),
  }),
  z.strictObject({ mode: z.literal('fixed'), genre: GenreSchema }),
]);
const fields = {
  genre: GenreModeSchema,
  rounds: z.number().int().min(1).max(20),
  submissionSeconds: z.number().int().min(30).max(300),
  clipSeconds: z.number().int().min(15).max(60),
  votingSeconds: z.number().int().min(30).max(180),
  anonymous: z.boolean(),
  genreFailPenalty: z.number().int().min(-10).max(0),
  linkedPoints: z.enum(['full', 'halfCeil']),
};
export const RequiredSettingsSchema = z.strictObject(fields);
export const SettingsSchema = RequiredSettingsSchema.extend({
  genre: fields.genre.default({ mode: 'roulette' }),
  rounds: fields.rounds.default(5),
  submissionSeconds: fields.submissionSeconds.default(90),
  clipSeconds: fields.clipSeconds.default(40),
  votingSeconds: fields.votingSeconds.default(60),
  anonymous: fields.anonymous.default(true),
  genreFailPenalty: fields.genreFailPenalty.default(-3),
  linkedPoints: fields.linkedPoints.default('full'),
});
export const DEFAULT_SETTINGS = SettingsSchema.parse({});
export type Settings = z.infer<typeof RequiredSettingsSchema>;
