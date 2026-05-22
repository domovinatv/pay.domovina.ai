import { Route, Switch } from 'wouter';
import { useWalletStore } from './state/store';
import { AppShell } from './components/AppShell';
import { Landing } from './routes/Landing';
import { Wallet } from './routes/Wallet';
import { Receive } from './routes/Receive';
import { Send } from './routes/Send';
import { BindPhone } from './routes/BindPhone';
import { Settings } from './routes/Settings';
import { UiPreview } from './routes/UiPreview';
import { BuildInfoFooter } from './components/BuildInfoFooter';

export function App() {
  const safeAddress = useWalletStore((s) => s.safeAddress);

  return (
    <Switch>
      {/* Design system gallery — always reachable */}
      <Route path="/ui-preview" component={UiPreview} />

      <Route>
        {!safeAddress ? (
          <>
            <Landing />
            <BuildInfoFooter />
          </>
        ) : (
          <AppShell>
            <Switch>
              <Route path="/" component={Wallet} />
              <Route path="/receive" component={Receive} />
              <Route path="/send" component={Send} />
              <Route path="/settings" component={Settings} />
              <Route path="/settings/phone" component={BindPhone} />
              <Route component={Wallet} />
            </Switch>
            <BuildInfoFooter />
          </AppShell>
        )}
      </Route>
    </Switch>
  );
}
