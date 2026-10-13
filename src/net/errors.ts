import type { z } from 'zod';
import type { RejectionSchema } from '../shared/protocol';

/** Engine rejection reasons, shared with the wire protocol. */
export type Rejection = z.infer<typeof RejectionSchema>;

/** Transport/session failures that are not engine rejections. */
export const SESSION_FAILURES = [
  'INVALID_ROOM_CODE',
  'ROOM_NOT_FOUND',
  'CONNECTION_FAILED',
  'CONFIGURATION',
  'IDENTITY_STORAGE',
  'STATE_LOST',
  'CLOCK_SYNC_FAILED',
  'COMMAND_TIMEOUT',
] as const;
export type SessionFailure = (typeof SESSION_FAILURES)[number];

export type SessionError = Rejection | SessionFailure;

export const REJECTIONS: readonly Rejection[] = [
  'INVALID',
  'WRONG_PHASE',
  'FORBIDDEN',
  'STALE',
  'ROOM_FULL',
  'NICKNAME_TAKEN',
  'KICKED',
  'RATE_LIMITED',
  'NOT_READY',
];

export function isRejection(value: SessionError): value is Rejection {
  return (REJECTIONS as readonly string[]).includes(value);
}

export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'migrating'
  | 'lost'
  | 'error';

export type CommandResult =
  | { status: 'accepted'; stateVersion: number }
  | { status: 'rejected'; reason: SessionError };
