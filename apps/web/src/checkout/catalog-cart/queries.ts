import type { Cart } from '@checkout/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HttpApiError } from '../../api/errors';
import { queryKeys } from '../../lib/query-client';
import { checkoutApi } from '../../runtime';

export const productsQueryOptions = queryOptions({
  queryKey: queryKeys.products,
  queryFn: ({ signal }) => checkoutApi.listProducts(signal),
});

export function cartQueryOptions(sessionScope: string) {
  return queryOptions({
    queryKey: queryKeys.cart(sessionScope),
    queryFn: ({ signal }) => checkoutApi.getCart(signal),
  });
}

type CartMutation =
  { kind: 'set'; productId: string; quantity: number } | { kind: 'remove'; productId: string };

function needsServerSync(error: unknown): boolean {
  return error instanceof HttpApiError && (error.status === 404 || error.status === 409);
}

export function useCatalogCart(sessionScope: string) {
  const queryClient = useQueryClient();
  const products = useQuery(productsQueryOptions);
  const cart = useQuery(cartQueryOptions(sessionScope));
  const mutation = useMutation({
    retry: false,
    mutationFn: (request: CartMutation) =>
      request.kind === 'set'
        ? checkoutApi.setCartItem(request.productId, request.quantity)
        : checkoutApi.removeCartItem(request.productId),
    onSuccess: async (authoritativeCart: Cart) => {
      const cartKey = queryKeys.cart(sessionScope);
      await queryClient.cancelQueries({ queryKey: cartKey });
      queryClient.setQueryData<Cart>(cartKey, (current) =>
        current && current.version > authoritativeCart.version ? current : authoritativeCart,
      );
    },
    onError: async (error) => {
      if (!needsServerSync(error)) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.cart(sessionScope) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products }),
      ]);
    },
  });

  return { products, cart, mutation };
}
