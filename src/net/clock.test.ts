import { describe, expect, it } from 'vitest';
import { ClockSync } from './clock';

describe('clock sync', () => {
  it('keeps the median offset and rtt over several samples', async () => {
    // Local clock starts at 0; each call advances 40 ms so the bracketing
    // send/receive pair of every sample spans a known 40 ms round trip.
    let local = 0;
    const localNow = () => {
      const value = local;
      local += 40;
      return value;
    };
    const sync = new ClockSync({
      fetchServerTime: async () => 1_000_000,
      localNow,
      samples: 3,
    });
    // Independent derivation: offsets = server - midpoint(send, receive).
    const offsets = [
      1_000_000 - (0 + 40) / 2,
      1_000_000 - (80 + 120) / 2,
      1_000_000 - (160 + 200) / 2,
    ];
    const expected = [...offsets].sort((a, b) => a - b)[1];
    expect(await sync.sync()).toBe(true);
    expect(sync.isSynchronized).toBe(true);
    expect(sync.offsetMs).toBe(expected);
    expect(sync.offsetMs).toBe(999900);
    expect(sync.rttMs).toBe(40);
  });

  it('stays explicitly unsynchronized when every sample fails', async () => {
    const sync = new ClockSync({
      fetchServerTime: async () => {
        throw new Error('offline');
      },
      localNow: () => 1234,
      samples: 2,
    });
    expect(await sync.sync()).toBe(false);
    expect(sync.isSynchronized).toBe(false);
    expect(sync.offsetMs).toBe(0);
    expect(sync.rttMs).toBeNull();
    expect(sync.serverNow()).toBe(1234);
  });

  it('averages the two middle offsets for an even sample count', async () => {
    const values = [1100, 1200];
    let call = 0;
    const sync = new ClockSync({
      fetchServerTime: async () => values[call++] ?? 0,
      localNow: () => 1000,
      samples: 2,
    });
    await sync.sync();
    expect(sync.offsetMs).toBe(150);
  });
});
