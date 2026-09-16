import type {
  Cart,
  Delivery,
  Order,
  Payment,
  Product,
  Quote,
  Simulation,
} from '@checkout/contracts';
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

export type Sandbox = {
  settlementDelayMs: number;
  cards: Array<{
    id: string;
    title: string;
    maskedNumber: string;
    scenario: 'success' | 'decline';
  }>;
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
  getSandbox(signal?: AbortSignal): Promise<Sandbox>;
  listPayments(orderId: string, signal?: AbortSignal): Promise<Payment[]>;
  createPayment(orderId: string, serializedBody: string, idempotencyKey: string): Promise<Payment>;
  getPayment(paymentId: string, signal?: AbortSignal): Promise<Payment>;
  simulatePayment(
    paymentId: string,
    scenario: 'success' | 'decline' | 'cancel',
  ): Promise<{ simulation: Simulation; retryAfterMs: number }>;
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
    async getSandbox(signal) {
      return (
        await client.request<Sandbox>({
          path: '/api/sandbox',
          method: 'GET',
          auth: 'public',
          signal,
        })
      ).data;
    },
    async listPayments(orderId, signal) {
      return (
        await client.request<Payment[]>({
          path: `/api/orders/${encodeURIComponent(orderId)}/payments`,
          method: 'GET',
          auth: 'session',
          signal,
        })
      ).data;
    },
    async createPayment(orderId, serializedBody, idempotencyKey) {
      return (
        await client.request<Payment>({
          path: `/api/orders/${encodeURIComponent(orderId)}/payments`,
          method: 'POST',
          auth: 'session',
          serializedBody,
          idempotencyKey,
        })
      ).data;
    },
    async getPayment(paymentId, signal) {
      return (
        await client.request<Payment>({
          path: `/api/payments/${encodeURIComponent(paymentId)}`,
          method: 'GET',
          auth: 'session',
          signal,
        })
      ).data;
    },
    async simulatePayment(paymentId, scenario) {
      const result = await client.request<Simulation>({
        path: `/api/payments/${encodeURIComponent(paymentId)}/simulations`,
        method: 'POST',
        auth: 'session',
        body: { scenario },
      });
      return { simulation: result.data, retryAfterMs: result.retryAfterMs ?? 750 };
    },
  };
}
