import type { Cart } from '@checkout/contracts';
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

export function createCheckoutApi(client: ApiClient): SessionApi {
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
    async getCart(signal) {
      const result = await client.request<Cart>({
        path: '/api/cart',
        method: 'GET',
        auth: 'session',
        signal,
      });
      return result.data;
    },
  };
}
