import { useWalletStore } from './state/store';
import { Landing } from './routes/Landing';
import { Wallet } from './routes/Wallet';
import { Receive } from './routes/Receive';
import { Send } from './routes/Send';
import { BindPhone } from './routes/BindPhone';
import { BuildInfoFooter } from './components/BuildInfoFooter';

export function App() {
  const screen = useWalletStore((s) => s.screen);
  const safeAddress = useWalletStore((s) => s.safeAddress);

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
