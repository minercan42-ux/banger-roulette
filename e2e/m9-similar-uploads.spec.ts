import { expect, test } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import {
  assembleRoom,
  closeStages,
  dispatch,
  newStage,
  snapshot,
  stateOf,
} from './m3-support';
import { playToPlayback, ratePlayback } from './m5-support';
import { fixtureThumbnail } from './youtube-fixture';

/**
 * Issue #106: two different uploads of the same song form one Spiritually
 * Linked song. Both submitters are owners and scored, and neither can rate it.
 */

const OFFICIAL = 'simhelloAA1';
const TOPIC = 'simhelloBB2';
const SOLO = 'simsoloCC03';

function mediaOf(
  videoId: string,
  title: string,
  channel: string,
  durationSeconds: number,
): Media {
  return {
    videoId,
    title,
    channel,
    thumbnail: fixtureThumbnail(videoId),
    durationSeconds,
    startSeconds: 0,
  };
}

const MEDIAS: Media[] = [
  mediaOf(OFFICIAL, 'Adele - Hello (Official Music Video)', 'Adele', 367),
  mediaOf(TOPIC, 'Hello', 'Adele - Topic', 366),
  mediaOf(SOLO, 'Lionel Richie - Hello', 'Lionel Richie', 367),
];

test('different uploads of one song become one linked song that its owners cannot rate', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all(
    ['Alice', 'Bob', 'Cara'].map((nickname) =>
      newStage(browser, { nickname, reducedMotion: 'no-preference' }),
    ),
  );
  try {
    const pages = stages.map((stage) => stage.page);
    const [alice, bob, cara] = pages as [
      (typeof pages)[0],
      (typeof pages)[0],
      (typeof pages)[0],
    ];
    await assembleRoom(stages[0]!, stages.slice(1));
    await playToPlayback(pages, MEDIAS);

    const playing = await stateOf(alice);
    const songs = playing?.round?.songs ?? [];
    expect(songs).toHaveLength(2);
    const linkedSong = songs.find((song) => song.ownerIds.length === 2)!;
    // First accepted upload is canonical; both uploads belong to the group.
    expect(linkedSong.media.videoId).toBe(OFFICIAL);
    expect(linkedSong.memberVideoIds).toEqual([OFFICIAL, TOPIC]);
    const aliceId = (await snapshot(alice)).clientId;
    const bobId = (await snapshot(bob)).clientId;
    expect(new Set(linkedSong.ownerIds)).toEqual(new Set([aliceId, bobId]));
    // Hello by Lionel Richie is a different song and stays separate.
    expect(
      songs.find((song) => song.media.videoId === SOLO)?.ownerIds,
    ).toHaveLength(1);

    // Neither owner can rate the linked song, whichever upload id they use.
    for (const owner of [alice, bob]) {
      for (const songId of [OFFICIAL, TOPIC]) {
        const result = await dispatch(owner, {
          type: 'RATE',
          songId,
          value: 5,
        });
        expect(result.status).toBe('rejected');
      }
    }

    await ratePlayback(pages, MEDIAS, () => 8);

    // One linked reveal entry with both owners, and both owners are scored.
    const linked = alice.getByTestId('linked-animation');
    await expect(linked).toBeVisible({ timeout: 10_000 });
    await expect(linked.getByTestId('linked-names')).toContainText('Alice');
    await expect(linked.getByTestId('linked-names')).toContainText('Bob');
    await expect(alice.getByTestId('reveal-entry')).toHaveCount(2);

    const reveal = await stateOf(cara);
    const result = reveal?.results[0];
    expect(result?.songs).toHaveLength(2);
    const scored = result?.songs.find(
      (entry) => entry.song.media.videoId === OFFICIAL,
    );
    expect(scored?.song.ownerIds).toHaveLength(2);
    expect(scored?.ratingCount).toBe(1);
    expect(scored?.scoreTenths).toBe(80);
    expect(result?.playerDeltas[aliceId]).toBe(result?.playerDeltas[bobId]);
    expect(result?.playerDeltas[aliceId]).toBeGreaterThan(0);
  } finally {
    await closeStages(stages);
  }
});
