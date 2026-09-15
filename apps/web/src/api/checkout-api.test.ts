import type { Cart } from '@checkout/contracts';
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
});
