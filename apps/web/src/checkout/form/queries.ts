import type { Delivery, Quote } from '@checkout/contracts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { HttpApiError } from '../../api/errors';
import { queryKeys } from '../../lib/query-client';
import { checkoutApi } from '../../runtime';

export function checkoutOptionsQueryOptions(sessionScope: string) {
  return queryOptions({
    queryKey: queryKeys.checkoutOptions(sessionScope),
    queryFn: ({ signal }) => checkoutApi.getCheckoutOptions(signal),
  });
}

export type QuoteRequest = { cartVersion: number; delivery: Delivery };

export function needsCheckoutSync(error: unknown): boolean {
  return error instanceof HttpApiError && [404, 409, 422].includes(error.status);
}

export function useQuoteMutation(sessionScope: string, onQuote: (quote: Quote | null) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: ({ cartVersion, delivery }: QuoteRequest) =>
      checkoutApi.createQuote(cartVersion, delivery),
    onSuccess: onQuote,
    onError: async (error) => {
      if (!needsCheckoutSync(error)) return;
      onQuote(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.cart(sessionScope) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.checkoutOptions(sessionScope) }),
      ]);
    },
  });
}
