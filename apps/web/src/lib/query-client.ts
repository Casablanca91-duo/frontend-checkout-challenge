import { QueryClient } from '@tanstack/react-query';
import { HttpApiError, NetworkError } from '../api/errors';

export const queryKeys = {
  public: ['public'] as const,
  products: ['public', 'products'] as const,
  authenticated: ['session'] as const,
  cart: (sessionScope: string) => ['session', sessionScope, 'cart'] as const,
  checkoutOptions: (sessionScope: string) => ['session', sessionScope, 'checkout-options'] as const,
  order: (sessionScope: string, orderId: string) =>
    ['session', sessionScope, 'order', orderId] as const,
  payments: (sessionScope: string, orderId: string) =>
    ['session', sessionScope, 'order', orderId, 'payments'] as const,
  payment: (sessionScope: string, paymentId: string) =>
    ['session', sessionScope, 'payment', paymentId] as const,
};

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  return error instanceof NetworkError || (error instanceof HttpApiError && error.status >= 500);
}

export function createCheckoutQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery },
      mutations: { retry: false },
    },
  });
}
