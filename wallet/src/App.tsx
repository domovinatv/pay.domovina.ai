import { useWalletStore } from './state/store';
import { Landing } from './routes/Landing';
import { Wallet } from './routes/Wallet';
import { Receive } from './routes/Receive';
import { Send } from './routes/Send';
import { BindPhone } from './routes/BindPhone';

export function App() {
  const screen = useWalletStore((s) => s.screen);
  const safeAddress = useWalletStore((s) => s.safeAddress);

  if (!safeAddress) return <Landing />;
  if (screen === 'receive') return <Receive />;
  if (screen === 'send') return <Send />;
  if (screen === 'bind-phone') return <BindPhone />;
  return <Wallet />;
}
