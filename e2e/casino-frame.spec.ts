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
  let previous: string | null = null;
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
    } else if (stop.id === first || stop.id === previous) {
      // Chromium moves the focus out of the document after the last control
      // (the `null` above); Firefox leaves it on that control, so a repeated
      // stop ends the tab order as well. Both paths stop at the same place.
      break;
    }
    previous = stop.id;
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
    // Home buttons: create room, join room and the shell's sound-effects
    // toggle, which the header owns since SPEC 6 effects exist.
    expect(tags.filter((tag) => tag === 'BUTTON')).toHaveLength(3);
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

/** WCAG 1.4.11: field bounds need 3:1 against what surrounds them. */
async function fieldBorderContrasts(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const parse = (value: string): [number, number, number, number] => {
      const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [
        numbers[0] ?? 0,
        numbers[1] ?? 0,
        numbers[2] ?? 0,
        numbers[3] ?? 1,
      ];
    };
    const luminance = ([r, g, b]: number[]): number => {
      const [lr, lg, lb] = [r, g, b].map((channel) => {
        const c = (channel ?? 0) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
    };
    const ratio = (a: number[], b: number[]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
    };
    const surround = (element: Element): number[] => {
      for (
        let node = element.parentElement;
        node !== null;
        node = node.parentElement
      ) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color[3] === 1) {
          return color;
        }
      }
      return [0, 0, 0, 1];
    };
    return Array.from(
      document.querySelectorAll(
        'input[type="text"], input[type="number"], select',
      ),
    ).map((element) => {
      const border = parse(getComputedStyle(element).borderTopColor);
      return ratio(border, surround(element));
    });
  });
}

test('Home and Lobby field borders meet 3:1 non-text contrast', async ({
  browser,
}) => {
  const host = await newStage(browser, { nickname: 'Ada' });
  try {
    const home = await fieldBorderContrasts(host.page);
    expect(home).toHaveLength(4);
    for (const ratio of home) {
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
    await createRoom(host.page, host.nickname);
    const lobby = await fieldBorderContrasts(host.page);
    expect(lobby.length).toBeGreaterThan(6);
    for (const ratio of lobby) {
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  } finally {
    await closeStages([host]);
  }
});

test('Page background renders a visible felt weave', async ({ browser }) => {
  const host = await newStage(browser, {
    nickname: 'Ada',
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  try {
    // Bare page margin left of the panel: only the body background is drawn.
    const png = await host.page.screenshot({
      clip: { x: 0, y: 0, width: 96, height: 96 },
    });
    const stddev = await host.page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (context === null) {
        throw new Error('2d canvas unavailable');
      }
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const lumas: number[] = [];
      for (let index = 0; index < data.length; index += 4) {
        lumas.push(
          0.2126 * (data[index] ?? 0) +
            0.7152 * (data[index + 1] ?? 0) +
            0.0722 * (data[index + 2] ?? 0),
        );
      }
      const mean = lumas.reduce((sum, value) => sum + value, 0) / lumas.length;
      const variance =
        lumas.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        lumas.length;
      return Math.sqrt(variance);
    }, png.toString('base64'));
    // Measured 4.2 with the hatch; a smooth gradient over 96 px is near 0.
    expect(stddev).toBeGreaterThan(1.5);
  } finally {
    await closeStages([host]);
  }
});
