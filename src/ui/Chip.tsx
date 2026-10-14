export type ChipTone = 'gold' | 'red' | 'black' | 'neon';
export type ChipSize = 'sm' | 'md' | 'lg';

interface ChipProps {
  tone: ChipTone;
  size: ChipSize;
  /** Accessible name. Without it the chip is purely decorative (`aria-hidden`). */
  label?: string;
}

interface ChipPalette {
  body: string;
  edge: string;
  ring: string;
  inset: string;
  mark: string;
}

const PALETTES: Record<ChipTone, ChipPalette> = {
  gold: {
    body: 'var(--color-gold-400)',
    edge: 'var(--color-cream-100)',
    ring: 'var(--color-gold-500)',
    inset: 'var(--color-gold-300)',
    mark: 'var(--color-felt-950)',
  },
  red: {
    body: 'var(--color-chip-red)',
    edge: 'var(--color-cream-100)',
    ring: 'var(--color-gold-300)',
    inset: '#a50d26',
    mark: 'var(--color-gold-200)',
  },
  black: {
    body: 'var(--color-ink-900)',
    edge: 'var(--color-gold-400)',
    ring: 'var(--color-gold-300)',
    inset: 'var(--color-ink-800)',
    mark: 'var(--color-gold-300)',
  },
  neon: {
    body: 'var(--color-ink-950)',
    edge: 'var(--color-neon-cyan)',
    ring: 'var(--color-neon-pink)',
    inset: 'var(--color-ink-900)',
    mark: 'var(--color-neon-cyan)',
  },
};

const SIZES: Record<ChipSize, string> = {
  sm: 'size-5',
  md: 'size-8',
  lg: 'size-12',
};

/**
 * Decorative poker chip drawn as inline SVG (no asset, SPEC section 6).
 * Geometry: 64x64 box, 16 edge stripes on r=27, a thin inner ring, a centre
 * diamond. Colours come from the design tokens in `styles.css`.
 */
export function Chip({ tone, size, label }: ChipProps) {
  const palette = PALETTES[tone];
  const labelled = label !== undefined && label !== '';
  return (
    <svg
      viewBox="0 0 64 64"
      data-testid="chip"
      data-tone={tone}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? label : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      className={`inline-block shrink-0 ${SIZES[size]}${
        tone === 'neon' ? ' animate-glow-pulse' : ''
      }`}
    >
      <circle cx="32" cy="32" r="30" fill={palette.body} />
      <circle
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke={palette.edge}
        strokeWidth="6"
        strokeDasharray="5.3 5.3"
      />
      <circle
        cx="32"
        cy="32"
        r="30"
        fill="none"
        stroke={palette.ring}
        strokeWidth="2"
      />
      <circle cx="32" cy="32" r="18" fill={palette.inset} />
      <circle
        cx="32"
        cy="32"
        r="18"
        fill="none"
        stroke={palette.ring}
        strokeWidth="1.5"
      />
      <path d="M32 23 L39 32 L32 41 L25 32 Z" fill={palette.mark} />
    </svg>
  );
}
