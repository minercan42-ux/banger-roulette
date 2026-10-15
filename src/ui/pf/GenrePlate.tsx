interface GenrePlateProps {
  /** Small line above the name, already translated. */
  kicker: string;
  /** Genre name in the current language; the plate upper-cases it in CSS. */
  name: string;
  /**
   * Make the plate itself the polite live region (design default). Pass
   * `false` when another element already announces the result, so screen
   * readers do not hear it twice; the plate is then hidden from them.
   */
  live?: boolean;
}

/** Names longer than this switch to the smaller plate type so they wrap. */
const LONG_NAME_CHARS = 16;

/**
 * Pixel-Filz genre plate (docs/design/pixel-filz/components/GenrePlate): the
 * red plaque with the drawn genre. It pops in on mount (`.is-in`, `br-pop-in`)
 * and bumps its name every 2.6 s; the reduced-motion block of the stylesheet
 * turns both into a plain fade.
 */
export function GenrePlate({ kicker, name, live = true }: GenrePlateProps) {
  return (
    <div
      data-testid="genre-plate"
      className="br-genre is-in"
      {...(live
        ? { role: 'status', 'aria-live': 'polite' as const }
        : { 'aria-hidden': true })}
    >
      <span className="br-genre__kicker">{kicker}</span>
      <strong
        className="br-genre__name"
        data-long={[...name].length > LONG_NAME_CHARS}
      >
        {name}
      </strong>
    </div>
  );
}
