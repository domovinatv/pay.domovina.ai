import { Route, Switch } from 'wouter';
import { useWalletStore } from './state/store';
import { AppShell } from './components/AppShell';
import { Landing } from './routes/Landing';
import { Wallet } from './routes/Wallet';
import { Receive } from './routes/Receive';
import { Send } from './routes/Send';
import { Activity } from './routes/Activity';
import { BindPhone } from './routes/BindPhone';
import { ExpandAccess } from './routes/ExpandAccess';
import { Settings } from './routes/Settings';
import { UiPreview } from './routes/UiPreview';
import { Embed } from './routes/Embed';
import { Link } from './routes/Link';
import { LinkCallback } from './routes/LinkCallback';
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

      {/* Cross-TLD linking flow.
          - /link is the master's authorize page; a tenant iframes here or
            redirects here, and we sign addOwnerWithThreshold on one of the
            user's Safes. Accessible without an active wallet because the
            visitor may be coming from a fresh tab.
          - /link-callback is the tenant's return target after the Safari
            redirect path. Pulls the pending passkey from sessionStorage
            and finalizes the local PasskeyRecord. */}
      <Route path="/link" component={Link} />
      <Route path="/link-callback" component={LinkCallback} />

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
              <Route path="/activity" component={Activity} />
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
