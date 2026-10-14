interface ChipProps {
  tone: 'gold' | 'red' | 'black' | 'neon';
  size: 'sm' | 'md' | 'lg';
  /** Localized accessible name; omit for purely decorative chips. */
  label?: string;
}

/** CSS-only poker chip: no image requests, focus target or duplicated label. */
export function Chip({ tone, size, label }: ChipProps) {
  return (
    <span
      className={`casino-chip casino-chip--${tone} casino-chip--${size}`}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <span className="casino-chip__center" />
    </span>
  );
}
