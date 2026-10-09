import { useEffect, useState } from 'preact/hooks';

import { API } from './config.js';

const POLL_MS = 5000;
const OPEN = new Set(['pending', 'received']);

/// Renders the EPC QR + live status for an order paid with the MPT manual
/// payment method. Renders NOTHING for any other order (card, PayPal …), and
/// nothing while loading, so non-MPT buyers never see a flash of this block.
export function PaymentBlock({ orderId }) {
  const [data, setData] = useState(null);
  const t = (key, vars) => shopify.i18n.translate(key, vars);

  useEffect(() => {
    if (!orderId) return undefined;
    let stopped = false;
    let timer;
    const load = async () => {
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${API}/ext/order?order_id=${encodeURIComponent(orderId)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          if (!stopped) setData(json);
          if (json.status === 'not_applicable' || !OPEN.has(json.status)) return; // final — stop polling
        }
      } catch {
        // transient — keep the last good state and retry
      }
      if (!stopped) timer = setTimeout(load, POLL_MS);
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [orderId]);

  if (!data || data.status === 'not_applicable' || !data.status) return null;

  const amount = shopify.i18n.formatCurrency(Number(data.amount_eur), { currency: 'EUR' });

  if (data.status === 'paid') {
    return <s-banner tone="success" heading={t('paid.heading')}>{t('paid.body', { amount })}</s-banner>;
  }
  if (data.status === 'underpaid') {
    return <s-banner tone="warning" heading={t('underpaid.heading')}>{t('underpaid.body')}</s-banner>;
  }
  if (data.status === 'rejected') {
    return <s-banner tone="critical" heading={t('rejected.heading')}>{t('rejected.body')}</s-banner>;
  }
  if (data.status === 'unavailable') {
    return <s-banner tone="warning" heading={t('unavailable.heading')}>{t('unavailable.body')}</s-banner>;
  }
  if (data.status === 'expired' || data.status === 'cancelled') {
    return <s-banner tone="warning" heading={t('expired.heading')}>{t('expired.body')}</s-banner>;
  }

  const qr = data.qr;
  return (
    <s-section heading={t('pay.heading')}>
      <s-stack gap="base">
        {data.status === 'received' ? (
          <s-banner tone="success" heading={t('received.heading')}>
            {data.review_expected ? t('received.review') : t('received.body')}
          </s-banner>
        ) : (
          <s-paragraph>{t('pay.instructions', { amount })}</s-paragraph>
        )}
        {data.status === 'pending' && qr ? (
          <s-stack gap="base">
            <s-qr-code content={qr.epc_qr_data} accessibilityLabel={t('pay.qrLabel')} />
            <s-stack gap="small-200">
              <s-text>{t('pay.amount')}: <s-text type="strong">{amount}</s-text></s-text>
              <s-text>{t('pay.beneficiary')}: {qr.beneficiary_name}</s-text>
              <s-text>IBAN: <s-text type="strong">{qr.iban}</s-text></s-text>
              {qr.bic ? <s-text>BIC: {qr.bic}</s-text> : null}
              <s-text>{t('pay.reference')}: <s-text type="strong">{qr.reference}</s-text></s-text>
            </s-stack>
            <s-paragraph>{t('pay.referenceWarning')}</s-paragraph>
            <s-link href={qr.checkout_url} target="_blank">{t('pay.openPage')}</s-link>
          </s-stack>
        ) : null}
        {data.status === 'pending' ? <s-text color="subdued">{t('pay.autoRefresh')}</s-text> : null}
      </s-stack>
    </s-section>
  );
}
