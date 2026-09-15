import type { Cart, Product } from '@checkout/contracts';
import type { ApiClient } from './client';

export type SessionPayload = {
  id: string;
  token: string;
  cart: Cart;
};

export type SessionApi = {
  createSession(signal?: AbortSignal): Promise<SessionPayload>;
  getCart(signal?: AbortSignal): Promise<Cart>;
};

export type CheckoutApi = SessionApi & {
  listProducts(signal?: AbortSignal): Promise<Product[]>;
  setCartItem(productId: string, quantity: number, signal?: AbortSignal): Promise<Cart>;
  removeCartItem(productId: string, signal?: AbortSignal): Promise<Cart>;
};

export function createCheckoutApi(client: ApiClient): CheckoutApi {
  const getCart = async (signal?: AbortSignal) => {
    const result = await client.request<Cart>({
      path: '/api/cart',
      method: 'GET',
      auth: 'session',
      signal,
    });
    return result.data;
  };

  return {
    async createSession(signal) {
      const result = await client.request<SessionPayload>({
        path: '/api/sessions',
        method: 'POST',
        auth: 'public',
        body: {},
        signal,
      });
      return result.data;
    },
    getCart,
    async listProducts(signal) {
      const result = await client.request<Product[]>({
        path: '/api/products',
        method: 'GET',
        auth: 'public',
        signal,
      });
      return result.data;
    },
    async setCartItem(productId, quantity, signal) {
      await client.request({
        path: `/api/cart/items/${encodeURIComponent(productId)}`,
        method: 'PUT',
        auth: 'session',
        body: { quantity },
        signal,
      });
      return getCart(signal);
    },
    async removeCartItem(productId, signal) {
      await client.request({
        path: `/api/cart/items/${encodeURIComponent(productId)}`,
        method: 'DELETE',
        auth: 'session',
        responseType: 'empty',
        signal,
      });
      return getCart(signal);
    },
  };
}
