import { Route, Switch } from 'wouter';
import { useWalletStore } from './state/store';
import { AppShell } from './components/AppShell';
import { Landing } from './routes/Landing';
import { Wallet } from './routes/Wallet';
import { Receive } from './routes/Receive';
import { Send } from './routes/Send';
import { BindPhone } from './routes/BindPhone';
import { ExpandAccess } from './routes/ExpandAccess';
import { Settings } from './routes/Settings';
import { UiPreview } from './routes/UiPreview';
import { Embed } from './routes/Embed';
import { BuildInfoFooter } from './components/BuildInfoFooter';

export function App() {
  const safeAddress = useWalletStore((s) => s.safeAddress);

  return (
    <Switch>
      {/* Design system gallery — always reachable */}
      <Route path="/ui-preview" component={UiPreview} />

      {/* Embedded SDK surface: served as a third-party iframe by community
          dApps; runs the wallet under our origin so the user's existing
          passkey + Safe registry remain native. See /sdk.js + Embed.tsx. */}
      <Route path="/embed" component={Embed} />

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
              <Route path="/settings/expand-access" component={ExpandAccess} />
              <Route component={Wallet} />
            </Switch>
            <BuildInfoFooter />
          </AppShell>
        )}
      </Route>
    </Switch>
  );
}
