import { useTranslation } from 'react-i18next';
import type { Phase } from '../shared/game';

interface PhaseUnavailableProps {
  phase: Phase['type'];
}

/**
 * Honest label for phases the app does not implement yet. The engine still
 * advances through them on deadlines, so the UI must say what is missing
 * instead of pretending voting or reveal already work (M5).
 */
export function PhaseUnavailable({ phase }: PhaseUnavailableProps) {
  const { t } = useTranslation();
  return (
    <p
      data-testid="phase-unavailable"
      data-phase={phase}
      className="rounded-xl border border-gold-400/20 bg-felt-800/50 px-3 py-3 text-sm text-cream-100/70"
    >
      {t(`later.${phase}`)}
    </p>
  );
}
