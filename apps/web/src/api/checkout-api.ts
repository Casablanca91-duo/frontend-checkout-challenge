import type { Cart, Delivery, Order, Product, Quote } from '@checkout/contracts';
import type { ApiClient } from './client';

export type CheckoutOptions = {
  cart: Cart;
  deliveryMethods: Array<{
    id: Delivery['method'];
    title: string;
    price: number;
    freeFrom: number | null;
    pickupPoints: Array<{ id: string; title: string; address: string }>;
  }>;
  paymentMethods: Array<{ id: 'card' | 'cash_on_delivery'; title: string }>;
};

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
  getCheckoutOptions(signal?: AbortSignal): Promise<CheckoutOptions>;
  createQuote(cartVersion: number, delivery: Delivery, signal?: AbortSignal): Promise<Quote>;
  createOrder(serializedBody: string, idempotencyKey: string): Promise<Order>;
  getOrder(orderId: string, signal?: AbortSignal): Promise<Order>;
  listOrders(signal?: AbortSignal): Promise<Order[]>;
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
    async getCheckoutOptions(signal) {
      const result = await client.request<CheckoutOptions>({
        path: '/api/checkout/options',
        method: 'GET',
        auth: 'session',
        signal,
      });
      return result.data;
    },
    async createQuote(cartVersion, delivery, signal) {
      const result = await client.request<Quote>({
        path: '/api/quotes',
        method: 'POST',
        auth: 'session',
        body: { cartVersion, delivery },
        signal,
      });
      return result.data;
    },
    async createOrder(serializedBody, idempotencyKey) {
      const result = await client.request<Order>({
        path: '/api/orders',
        method: 'POST',
        auth: 'session',
        serializedBody,
        idempotencyKey,
      });
      return result.data;
    },
    async getOrder(orderId, signal) {
      const result = await client.request<Order>({
        path: `/api/orders/${encodeURIComponent(orderId)}`,
        method: 'GET',
        auth: 'session',
        signal,
      });
      return result.data;
    },
    async listOrders(signal) {
      const result = await client.request<Order[]>({
        path: '/api/orders',
        method: 'GET',
        auth: 'session',
        signal,
      });
      return result.data;
    },
  };
}
