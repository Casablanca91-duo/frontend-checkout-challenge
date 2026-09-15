import type { Cart, Delivery, Quote } from '@checkout/contracts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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

export function quoteRequestSignature({ cartVersion, delivery }: QuoteRequest): string {
  if (delivery.method === 'pickup') {
    return JSON.stringify([cartVersion, 'pickup', delivery.pickupPointId.trim()]);
  }
  const { city, street, house, apartment } = delivery.address;
  return JSON.stringify([
    cartVersion,
    'courier',
    city.trim(),
    street.trim(),
    house.trim(),
    apartment?.trim() ?? '',
  ]);
}

export function needsCheckoutSync(error: unknown): boolean {
  return error instanceof HttpApiError && [404, 409, 422].includes(error.status);
}

type QuoteMutationResult =
  | {
      status: 'accepted';
      quote: Quote;
      revision: number;
      signature: string;
      cartVersion: number;
    }
  | { status: 'stale' };

export function useQuoteMutation(
  sessionScope: string,
  currentSignature: string | null,
  onQuote: (quote: Quote | null) => void,
) {
  const queryClient = useQueryClient();
  const revision = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const signatureRef = useRef(currentSignature);
  const previousSignature = useRef(currentSignature);
  signatureRef.current = currentSignature;

  const isCurrentRequest = (
    requestRevision: number,
    requestSignature: string,
    cartVersion: number,
  ) =>
    requestRevision === revision.current &&
    requestSignature === signatureRef.current &&
    queryClient.getQueryData<Cart>(queryKeys.cart(sessionScope))?.version === cartVersion;

  const invalidate = useCallback(() => {
    revision.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    onQuote(null);
  }, [onQuote]);

  useLayoutEffect(() => {
    if (previousSignature.current === currentSignature) return;
    previousSignature.current = currentSignature;
    invalidate();
  }, [currentSignature, invalidate]);

  useEffect(
    () => () => {
      revision.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    },
    [],
  );

  const mutation = useMutation<QuoteMutationResult, unknown, QuoteRequest>({
    retry: false,
    mutationFn: async (request) => {
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      const requestRevision = ++revision.current;
      const requestSignature = quoteRequestSignature(request);
      try {
        const quote = await checkoutApi.createQuote(
          request.cartVersion,
          request.delivery,
          controller.signal,
        );
        if (activeController.current === controller) activeController.current = null;
        if (!isCurrentRequest(requestRevision, requestSignature, request.cartVersion)) {
          return { status: 'stale' };
        }
        return {
          status: 'accepted',
          quote,
          revision: requestRevision,
          signature: requestSignature,
          cartVersion: request.cartVersion,
        };
      } catch (error) {
        if (activeController.current === controller) activeController.current = null;
        if (!isCurrentRequest(requestRevision, requestSignature, request.cartVersion)) {
          return { status: 'stale' };
        }
        throw error;
      }
    },
    onSuccess: (result) => {
      if (
        result.status === 'accepted' &&
        isCurrentRequest(result.revision, result.signature, result.cartVersion)
      ) {
        onQuote(result.quote);
      }
    },
    onError: async (error) => {
      if (!needsCheckoutSync(error)) return;
      onQuote(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.cart(sessionScope) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.checkoutOptions(sessionScope) }),
      ]);
    },
  });

  return { ...mutation, invalidate };
}
