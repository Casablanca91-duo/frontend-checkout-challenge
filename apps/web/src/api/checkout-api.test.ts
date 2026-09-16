import type { Cart, Quote } from '@checkout/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './client';
import { createCheckoutApi } from './checkout-api';

const cart: Cart = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 1,
  items: [],
  quantity: 0,
  subtotal: 0,
  currency: 'RUB',
};

const quote: Quote = {
  id: '00000000-0000-4000-8000-000000000004',
  cartVersion: 1,
  items: [],
  delivery: { method: 'pickup', pickupPointId: 'point-center' },
  subtotal: 249000,
  shipping: 0,
  total: 249000,
  currency: 'RUB',
  expiresAt: '2026-09-15T14:10:00.000Z',
};

function makeApi(responses: unknown[]) {
  const request = vi.fn().mockImplementation(async () => responses.shift());
  return { api: createCheckoutApi({ request } as unknown as ApiClient), request };
}

describe('checkout API', () => {
  it('loads Products through the public API namespace', async () => {
    const { api, request } = makeApi([{ data: [], meta: { requestId: '1' }, links: {} }]);

    await api.listProducts();

    expect(request).toHaveBeenCalledWith({
      path: '/api/products',
      method: 'GET',
      auth: 'public',
      signal: undefined,
    });
  });

  it('sets an absolute quantity and then returns the authoritative Cart', async () => {
    const itemEnvelope = { data: {}, meta: { requestId: '1' }, links: {} };
    const cartEnvelope = { data: cart, meta: { requestId: '2' }, links: {} };
    const { api, request } = makeApi([itemEnvelope, cartEnvelope]);

    await expect(api.setCartItem('lamp/orbit', 3)).resolves.toBe(cart);

    expect(request).toHaveBeenNthCalledWith(1, {
      path: '/api/cart/items/lamp%2Forbit',
      method: 'PUT',
      auth: 'session',
      body: { quantity: 3 },
      signal: undefined,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      path: '/api/cart',
      method: 'GET',
      auth: 'session',
      signal: undefined,
    });
  });

  it('deletes without a request body, accepts 204, and refetches Cart', async () => {
    const cartEnvelope = { data: cart, meta: { requestId: '2' }, links: {} };
    const { api, request } = makeApi([undefined, cartEnvelope]);

    await expect(api.removeCartItem('lamp-orbit')).resolves.toBe(cart);

    expect(request).toHaveBeenNthCalledWith(1, {
      path: '/api/cart/items/lamp-orbit',
      method: 'DELETE',
      auth: 'session',
      responseType: 'empty',
      signal: undefined,
    });
    expect(request.mock.calls[0][0]).not.toHaveProperty('body');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('loads authenticated checkout options', async () => {
    const options = { cart, deliveryMethods: [], paymentMethods: [] };
    const { api, request } = makeApi([{ data: options, meta: { requestId: '1' }, links: {} }]);

    await expect(api.getCheckoutOptions()).resolves.toBe(options);
    expect(request).toHaveBeenCalledWith({
      path: '/api/checkout/options',
      method: 'GET',
      auth: 'session',
      signal: undefined,
    });
  });

  it('creates a Quote with the supplied Cart version and Delivery payload', async () => {
    const { api, request } = makeApi([{ data: quote, meta: { requestId: '1' }, links: {} }]);

    await expect(api.createQuote(7, quote.delivery)).resolves.toBe(quote);
    expect(request).toHaveBeenCalledWith({
      path: '/api/quotes',
      method: 'POST',
      auth: 'session',
      body: { cartVersion: 7, delivery: quote.delivery },
      signal: undefined,
    });
  });

  it('sends a prepared Order body unchanged with one key and loads authoritative Order', async () => {
    const order = { id: '00000000-0000-4000-8000-000000000005' };
    const { api, request } = makeApi([{ data: order }, { data: order }, { data: [order] }]);
    const serializedBody =
      '{"quoteId":"quote-1","customer":{"name":"Buyer"},"paymentMethod":"card"}';
    await expect(api.createOrder(serializedBody, 'key-1')).resolves.toBe(order);
    expect(request).toHaveBeenNthCalledWith(1, {
      path: '/api/orders',
      method: 'POST',
      auth: 'session',
      serializedBody,
      idempotencyKey: 'key-1',
    });
    await expect(api.getOrder(order.id)).resolves.toBe(order);
    expect(request).toHaveBeenNthCalledWith(2, {
      path: `/api/orders/${order.id}`,
      method: 'GET',
      auth: 'session',
      signal: undefined,
    });
    await expect(api.listOrders()).resolves.toEqual([order]);
    expect(request).toHaveBeenNthCalledWith(3, {
      path: '/api/orders',
      method: 'GET',
      auth: 'session',
      signal: undefined,
    });
  });

  it('uses public sandbox cards and exact serialized Payment body/key; forwards simulation timing', async () => {
    const sandbox = {
      cards: [{ id: 'ok', title: 'Test', maskedNumber: '**** 4242', scenario: 'success' }],
      settlementDelayMs: 1200,
    };
    const payment = { id: 'payment-1', status: 'pending' };
    const simulation = { id: 'simulation-1', status: 'processing' };
    const { api, request } = makeApi([
      { data: sandbox },
      { data: [payment] },
      { data: payment },
      { data: simulation, retryAfterMs: 1000 },
      { data: payment },
    ]);
    await expect(api.getSandbox()).resolves.toBe(sandbox);
    await expect(api.listPayments('order-1')).resolves.toEqual([payment]);
    await expect(api.createPayment('order-1', '{}', 'key-1')).resolves.toBe(payment);
    await expect(api.simulatePayment('payment-1', 'decline')).resolves.toEqual({
      simulation,
      retryAfterMs: 1000,
    });
    await api.getPayment('payment-1');
    expect(request.mock.calls.map(([options]) => options)).toEqual([
      { path: '/api/sandbox', method: 'GET', auth: 'public', signal: undefined },
      { path: '/api/orders/order-1/payments', method: 'GET', auth: 'session', signal: undefined },
      {
        path: '/api/orders/order-1/payments',
        method: 'POST',
        auth: 'session',
        serializedBody: '{}',
        idempotencyKey: 'key-1',
      },
      {
        path: '/api/payments/payment-1/simulations',
        method: 'POST',
        auth: 'session',
        body: { scenario: 'decline' },
      },
      { path: '/api/payments/payment-1', method: 'GET', auth: 'session', signal: undefined },
    ]);
  });
});
