import { useTranslation } from 'react-i18next';

/** Bilingual disclosure of the completed M5 game loop and the remaining milestones. */
export function MilestoneNotice() {
  const { t } = useTranslation();
  return (
    <aside
      data-testid="milestone-notice"
      className="rounded-lg border border-gold-400/20 bg-felt-800/60 p-3 text-xs leading-relaxed text-cream-100/70"
    >
      <p className="font-semibold text-gold-300">{t('milestone.title')}</p>
      <p className="mt-1">{t('milestone.body')}</p>
      <p className="mt-1">{t('milestone.startHint')}</p>
    </aside>
  );
}
