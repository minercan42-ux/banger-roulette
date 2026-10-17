import { useTranslation } from 'react-i18next';
import { grantConsent, revokeConsent, useEmbedConsent } from './embed-consent';
import { Badge } from './pf/Badge';
import { Button } from './pf/Button';
import { Panel } from './pf/Panel';

/**
 * Drawer control for the YouTube embedding consent the start gate collected.
 * Revoking forgets the stored choice and stops every YouTube load at once;
 * after "Ohne Videos" the same place offers to turn videos on later.
 */
export function ConsentControl() {
  const { t } = useTranslation();
  const { consented } = useEmbedConsent();

  return (
    <Panel as="section" data-testid="consent-control" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="br-label">{t('consent.statusLabel')}</span>
        <Badge
          data-testid="consent-status"
          data-consented={consented}
          tone={consented ? 'green' : 'slate'}
          dot={consented}
        >
          {consented ? t('consent.on') : t('consent.off')}
        </Badge>
      </div>
      <Button
        tone="slate"
        size="sm"
        data-testid={consented ? 'consent-revoke' : 'consent-grant'}
        onClick={consented ? revokeConsent : grantConsent}
      >
        {consented ? t('consent.revoke') : t('consent.grant')}
      </Button>
    </Panel>
  );
}
