import { z } from 'zod';
import { ClientActionSchema } from './actions.js';
import { GameStateSchema } from './game.js';
import { Id, Int, RoomCode, Thumbnail, Time } from './primitives.js';

export const RejectionSchema = z.enum([
  'INVALID',
  'WRONG_PHASE',
  'FORBIDDEN',
  'STALE',
  'ROOM_FULL',
  'NICKNAME_TAKEN',
  'KICKED',
  'RATE_LIMITED',
  'NOT_READY',
]);
export const WireBodySchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('COMMAND'),
    commandId: Id,
    gameNumber: Int,
    roundNumber: Int,
    command: ClientActionSchema,
  }),
  z.strictObject({
    type: z.literal('SNAPSHOT'),
    recipientId: Id.nullable(),
    ackClientId: Id.nullable(),
    state: GameStateSchema,
  }),
  z.strictObject({
    type: z.literal('HOST_HANDOFF'),
    recipientId: Id,
    baseVersion: Int,
    state: GameStateSchema,
  }),
  z.strictObject({
    type: z.literal('STATE_REQUEST'),
    knownVersion: Int.nullable(),
  }),
  z.strictObject({ type: z.literal('SNAPSHOT_ACK'), stateVersion: Int }),
  z.strictObject({
    type: z.literal('COMMAND_RESULT'),
    recipientId: Id,
    commandId: Id,
    result: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('accepted'), stateVersion: Int }),
      z.strictObject({
        status: z.literal('rejected'),
        reason: RejectionSchema,
      }),
    ]),
  }),
  z.strictObject({
    type: z.literal('HOST_CLAIM'),
    baseVersion: Int,
    candidateId: Id,
  }),
  z.strictObject({
    type: z.literal('REPLICA_SNAPSHOT'),
    recipientId: Id,
    state: GameStateSchema,
  }),
  z.strictObject({
    type: z.literal('SNAPSHOT_PART'),
    transferId: Id,
    stateVersion: Int,
    index: z.number().int().min(0).max(127),
    total: z.number().int().min(1).max(128),
    dataBase64: z
      .string()
      .min(4)
      .max(65536)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  }),
]);
export const NetworkEventSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    roomCode: RoomCode,
    roomId: Id.nullable(),
    senderId: Id,
    connectionId: Id,
    hostEpoch: Int,
    sentAt: Time,
    body: WireBodySchema,
  })
  .superRefine((event, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (event.roomId === null && event.body.type !== 'STATE_REQUEST')
      invalid('Only discovery requests may omit roomId');
    const body = event.body;
    if (
      body.type === 'HOST_CLAIM' &&
      (body.candidateId !== event.senderId || event.hostEpoch === 0)
    )
      invalid('Invalid host claim');
    if (body.type === 'SNAPSHOT_PART' && body.index >= body.total)
      invalid('Invalid part index');
    if (
      body.type === 'SNAPSHOT' ||
      body.type === 'REPLICA_SNAPSHOT' ||
      body.type === 'HOST_HANDOFF'
    ) {
      if (
        body.state.roomId !== event.roomId ||
        body.state.roomCode !== event.roomCode ||
        body.state.hostEpoch !== event.hostEpoch
      )
        invalid('Envelope/state identity mismatch');
      if (
        body.type === 'HOST_HANDOFF' &&
        (body.recipientId !== event.senderId ||
          body.state.hostId !== event.senderId ||
          body.state.players[event.senderId]?.connectionId ===
            event.connectionId ||
          body.state.stateVersion !== body.baseVersion + 1)
      )
        invalid('Invalid host connection handoff');
      if (body.type === 'SNAPSHOT') {
        if (
          event.senderId !== body.state.hostId ||
          event.connectionId !==
            body.state.players[event.senderId]?.connectionId
        )
          invalid('Snapshot must come from host connection');
        if (body.recipientId !== null && !body.state.players[body.recipientId])
          invalid('Unknown snapshot recipient');
        const replica = Object.values(body.state.players)
          .filter(
            (p) =>
              p.id !== body.state.hostId &&
              p.connected &&
              p.status !== 'kicked' &&
              p.status !== 'left',
          )
          .sort(
            (a, b) =>
              a.joinedAt - b.joinedAt ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )[0];
        if (body.ackClientId !== (replica?.id ?? null))
          invalid('Invalid designated replica');
      }
    }
  });
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;
export const PresenceSchema = z.strictObject({
  protocolVersion: z.literal(1),
  clientId: Id,
  connectionId: Id,
  roomId: Id,
});
export type Presence = z.infer<typeof PresenceSchema>;
export const TimeResponseSchema = z.strictObject({ serverNow: Time });
export const OEmbedResponseSchema = z.strictObject({
  title: z.string().min(1).max(500),
  channel: z.string().min(1).max(200),
  thumbnail: Thumbnail,
});
