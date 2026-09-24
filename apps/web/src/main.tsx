import '@fontsource-variable/inter/wght.css';
import './styles/global.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiRequestError } from './api/client';
import { datasetQuery, tracksQuery } from './api/queries';
import { appStore } from './state/store';
import { parseUrlState } from './state/url';

const MAX_RETRIES = 2;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry transient failures only; a 4xx will not fix itself.
      retry: (failureCount, error) =>
        failureCount < MAX_RETRIES && (!(error instanceof ApiRequestError) || error.retryable),
      refetchOnWindowFocus: false,
    },
  },
});

// The map is created on first render: give it the linked projection and camera up front.
appStore.getState().restoreView(parseUrlState(window.location.search));

// Start both downloads now, in parallel with fetching and parsing the map code (~500 KB of JS in
// the lazily imported App): the tracks no longer wait behind the vendor bundles.
// Failures are not lost: they stay in the cache and surface through useQuery (error card + retry).
void queryClient.query(datasetQuery).catch(() => undefined);
void queryClient.query(tracksQuery).catch(() => undefined);
const { App } = await import('./App');

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
