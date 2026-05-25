import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './ui';
import { UpdateBanner } from './components/UpdateBanner';
import { applyBrandCss } from './app/applyBrandCss';
import './styles/index.css';

// Push the active brand's palette to :root before the first React render
// so the initial paint already uses the right colors (no flash of
// default-brand colors when a non-default tenant build loads).
applyBrandCss();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
      <UpdateBanner />
    </ToastProvider>
  </React.StrictMode>,
);
