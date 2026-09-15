import { QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '../checkout/session/SessionProvider';
import { createCheckoutQueryClient } from '../lib/query-client';

const queryClient = createCheckoutQueryClient();

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
