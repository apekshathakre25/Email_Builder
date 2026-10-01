import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';

import './styles/index.css';
import App from './App';
import { queryClient } from './lib/queryClient';
import { AppConfigProvider } from './providers/AppConfigProvider';
import { AuthProvider } from './providers/AuthProvider';
import { ToastProvider } from './providers/ToastProvider';
import { ConfirmProvider } from './providers/ConfirmProvider';
import { purgeLegacyLocalStorage } from './features/dashboard/campaignFormStorage';

/**
 * Removes SMTP settings an earlier version of the app left in localStorage, where
 * they were shared across accounts on the same browser profile. Done before the
 * first render so a stored credential is never available to any component.
 */
purgeLegacyLocalStorage();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppConfigProvider>
        <ToastProvider>
          <ConfirmProvider>
            {/* Inside the router: AuthProvider does not navigate itself, but the
                hooks that consume it do, and keeping the whole tree under one
                router avoids two histories. */}
            <BrowserRouter>
              <AuthProvider>
                <App />
              </AuthProvider>
            </BrowserRouter>
          </ConfirmProvider>
        </ToastProvider>
      </AppConfigProvider>
    </QueryClientProvider>
  </StrictMode>
);
