import type {
  CSSProperties,
  HTMLAttributes,
  MouseEventHandler,
  ReactNode,
} from 'react';
import { cx } from './cx';

/** What the front face prints. Never carries an owner: that is `owner`'s job, reveal only. */
export interface SongCardSong {
  title: string;
  channel: string;
  thumbnail: string;
}

/** Tilt of the cards in a hand, -6deg to 9deg (brand book, "Karten"). */
const FAN_ROTATIONS = [-6, 3, -3, 7, 0, 9, -5, 4] as const;

/** Rotation in degrees of the card at `index` in a hand. */
export function fanRotation(index: number): number {
  return FAN_ROTATIONS[index % FAN_ROTATIONS.length]!;
}

interface SongCardProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'onClick' | 'title'
> {
  /** Song number printed in both corners. */
  number: number;
  /** Front face data. Without it only the pixel-pattern back exists in the DOM. */
  song?: SongCardSong;
  /** Face up. Defaults to "the front face has data". */
  flipped?: boolean;
  /** Load the thumbnail (YouTube content, only after the embed consent). */
  showThumbnail?: boolean;
  thumbnailTestId?: string;
  /** Position in a hand: tilt from the fan table plus, on a static card, a staggered idle wobble. */
  index?: number;
  /** Chosen by the viewer: gold frame, lifted. */
  selected?: boolean;
  /** Round winner: gold glow. */
  winner?: boolean;
  /** Not selectable (own song). */
  dim?: boolean;
  /** Place in a ranking, a badge on the corner. */
  rank?: number;
  /** Owner stamp. Reveal only (AK-3): no other phase may pass this. */
  owner?: string;
  /** Slot for a genre-fail badge on the bottom edge. */
  flag?: ReactNode;
  /**
   * Accessible name (number and title, never an owner before the reveal).
   * Omit for a card whose row already says everything in text: it is then
   * hidden from assistive technology.
   */
  label?: string;
  /** Makes the card a button. */
  onClick?: MouseEventHandler<HTMLElement>;
  /** Toggle state of a button card. */
  pressed?: boolean;
  disabled?: boolean;
  /** Native tooltip with the full title. */
  tooltip?: string;
}

/**
 * Pixel-Filz song card (docs/design/pixel-filz/components/SongCard): a
 * submitted song as a playing card, face down with the pixel pattern or face up
 * with thumbnail, title and channel. The flip is a CSS transition on
 * `.is-flipped` (`dur-reveal`, `ease-spring`); `styles.css` collapses it to a
 * 1 ms change and stops the idle wobble under reduced motion.
 */
export function SongCard({
  number,
  song,
  flipped,
  showThumbnail = false,
  thumbnailTestId,
  index,
  selected = false,
  winner = false,
  dim = false,
  rank,
  owner,
  flag,
  label,
  onClick,
  pressed,
  disabled,
  tooltip,
  className,
  style,
  ...rest
}: SongCardProps) {
  const interactive = onClick !== undefined;
  // Buttons keep their tilt but never idle-wobble: a click target that keeps
  // moving is hard to hit (and never "stable" for a browser automation click).
  const wobble = index !== undefined && !interactive;
  const faceUp = song !== undefined && (flipped ?? true);
  const fan: CSSProperties | undefined =
    index === undefined
      ? undefined
      : ({
          '--r': `${fanRotation(index)}deg`,
          animationDelay: `${-(index % 5) * 0.6}s`,
        } as CSSProperties);
  const classes = cx(
    'br-card',
    faceUp && 'is-flipped',
    selected && 'is-selected',
    winner && 'is-winner',
    dim && 'is-dim',
    !interactive && 'br-card--static',
    wobble && 'br-wobble',
    className,
  );
  const body = (
    <>
      <span aria-hidden="true" className="br-card__inner">
        <span className="br-card__back" />
        {song !== undefined && (
          <span className="br-card__face br-card__face--front">
            <span className="br-card__corner">{number}</span>
            <span className="br-card__mid">
              {showThumbnail && song.thumbnail !== '' ? (
                <img
                  data-testid={thumbnailTestId}
                  src={song.thumbnail}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  referrerPolicy="no-referrer"
                  className="br-card__thumb"
                />
              ) : (
                <span className="br-card__thumb" />
              )}
              <span className="br-card__title">{song.title}</span>
              <span className="br-card__sub">{song.channel}</span>
            </span>
            <span className="br-card__corner br-card__corner--end">
              {number}
            </span>
          </span>
        )}
      </span>
      {rank !== undefined && (
        <span aria-hidden="true" className="br-card__rank">
          {rank}
        </span>
      )}
      {flag !== undefined && flag !== null && (
        <span aria-hidden="true" className="br-card__flag">
          {flag}
        </span>
      )}
      {owner !== undefined && (
        <span aria-hidden="true" className="br-card__owner">
          {owner}
        </span>
      )}
    </>
  );

  if (interactive) {
    return (
      <button
        {...rest}
        type="button"
        title={tooltip}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={classes}
        style={{ ...fan, ...style }}
      >
        {body}
      </button>
    );
  }
  // A decorative card: its row carries the text. A labelled one is a group so
  // the name is allowed on it.
  return (
    <div
      {...rest}
      title={tooltip}
      role={label === undefined ? undefined : 'group'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={classes}
      style={{ ...fan, ...style }}
    >
      {body}
    </div>
  );
}
