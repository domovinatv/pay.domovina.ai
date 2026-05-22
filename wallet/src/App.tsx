import { useWalletStore } from './state/store';
import { Landing } from './routes/Landing';
import { Wallet } from './routes/Wallet';
import { Receive } from './routes/Receive';
import { Send } from './routes/Send';
import { BindPhone } from './routes/BindPhone';
import { UiPreview } from './routes/UiPreview';
import { BuildInfoFooter } from './components/BuildInfoFooter';

// Temporary preview escape hatch — Phase 0 design system gallery.
// Phase 1 will introduce a real router (wouter); this check goes away then.
const isPreview =
  typeof window !== 'undefined' &&
  (window.location.pathname.startsWith('/ui-preview') ||
    window.location.search.includes('ui=preview'));

export function App() {
  const screen = useWalletStore((s) => s.screen);
  const safeAddress = useWalletStore((s) => s.safeAddress);

  if (isPreview) return <UiPreview />;

  let route;
  if (!safeAddress) route = <Landing />;
  else if (screen === 'receive') route = <Receive />;
  else if (screen === 'send') route = <Send />;
  else if (screen === 'bind-phone') route = <BindPhone />;
  else route = <Wallet />;

  return (
    <>
      {route}
      <BuildInfoFooter />
    </>
  );
}
