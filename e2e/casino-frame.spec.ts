import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeStages, createRoom, joinRoom, newStage } from './m3-support';

/**
 * SPEC section 6 frame: one global gold focus ring on every interactive
 * element, the decorative chip primitive, and no horizontal overflow at 360 px.
 */

interface FocusStop {
  id: string;
  tag: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  outlineOffset: string;
}

const GOLD_300 = 'rgb(236, 208, 127)';

/** Tabs through the whole page once and records the ring of every stop. */
async function tabThrough(page: Page): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  let first: string | null = null;
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press('Tab');
    // Tailwind `transition` utilities animate outline-color; read the settled ring.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished),
      ),
    );
    const stop = await page.evaluate((): FocusStop | null => {
      const element = document.activeElement;
      if (element === null || element === document.body) {
        return null;
      }
      const style = getComputedStyle(element);
      const marker = element.getAttribute('data-testid') ?? element.tagName;
      return {
        id: `${marker}#${Array.from(document.querySelectorAll('*')).indexOf(element)}`,
        tag: element.tagName,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        outlineOffset: style.outlineOffset,
      };
    });
    if (stop === null) {
      break;
    }
    if (first === null) {
      first = stop.id;
    } else if (stop.id === first) {
      break;
    }
    stops.push(stop);
  }
  return stops;
}

function expectRing(stops: readonly FocusStop[]): void {
  for (const stop of stops) {
    expect(stop, `focus ring on ${stop.id}`).toMatchObject({
      outlineStyle: 'solid',
      outlineWidth: '3px',
      outlineColor: GOLD_300,
      outlineOffset: '2px',
    });
  }
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test('Home: every focusable control shows the gold focus ring on Tab', async ({
  browser,
}) => {
  const host = await newStage(browser, { nickname: 'Ada' });
  try {
    const stops = await tabThrough(host.page);
    const tags = stops.map((stop) => stop.tag);
    expect(tags).toContain('SELECT');
    expect(tags.filter((tag) => tag === 'INPUT')).toHaveLength(3);
    expect(tags.filter((tag) => tag === 'BUTTON')).toHaveLength(2);
    expectRing(stops);
  } finally {
    await closeStages([host]);
  }
});

test('Lobby: every focusable control shows the gold focus ring on Tab', async ({
  browser,
}) => {
  const host = await newStage(browser, { nickname: 'Ada' });
  try {
    await createRoom(host.page, host.nickname);
    const stops = await tabThrough(host.page);
    const tags = new Set(stops.map((stop) => stop.tag));
    expect(tags).toContain('SELECT');
    expect(tags).toContain('BUTTON');
    expect(tags).toContain('INPUT');
    expect(stops.length).toBeGreaterThan(8);
    expectRing(stops);
  } finally {
    await closeStages([host]);
  }
});

test('Frame: chips are decorative and the host badge carries one', async ({
  browser,
}) => {
  const host = await newStage(browser, { nickname: 'Ada' });
  try {
    const header = host.page.getByTestId('app-shell').locator('header');
    const headerChips = header.getByTestId('chip');
    await expect(headerChips).toHaveCount(3);
    await expect(headerChips.first()).toHaveAttribute('aria-hidden', 'true');

    await createRoom(host.page, host.nickname);
    const badge = host.page.getByTestId('player-host-badge');
    await expect(badge.getByTestId('chip')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(badge).toHaveText(/host/i);
  } finally {
    await closeStages([host]);
  }
});

test('Frame: no horizontal overflow at 360 px on Home and in the Lobby', async ({
  browser,
}) => {
  const host = await newStage(browser, {
    nickname: 'Ada',
    viewport: { width: 360, height: 740 },
  });
  const guest = await newStage(browser, {
    nickname: 'Bob',
    viewport: { width: 360, height: 740 },
  });
  try {
    expect(await horizontalOverflow(host.page)).toBeLessThanOrEqual(0);
    const code = await createRoom(host.page, host.nickname);
    await joinRoom(guest.page, code, guest.nickname);
    await expect(host.page.getByTestId('roster-row')).toHaveCount(2);
    expect(await horizontalOverflow(host.page)).toBeLessThanOrEqual(0);
    expect(await horizontalOverflow(guest.page)).toBeLessThanOrEqual(0);
  } finally {
    await closeStages([host, guest]);
  }
});
