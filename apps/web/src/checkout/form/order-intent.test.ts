import type { CreateOrder, Order } from '@checkout/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpApiError, NetworkError } from '../../api/errors';
import type { CheckoutApi } from '../../api/checkout-api';
import { createRecoveryStorage } from '../../lib/storage';
import { pendingOrder, prepareOrder, sendOrderIntent } from './order-intent';

const body: CreateOrder = {
  quoteId: '00000000-0000-4000-8000-000000000004',
  customer: { name: 'Покупатель', email: 'buyer@example.test', phone: '+79990000000' },
  paymentMethod: 'cash_on_delivery',
};

const order = { id: '00000000-0000-4000-8000-000000000005' } as Order;

describe('Create Order intent', () => {
  const storage = createRecoveryStorage(localStorage);
  beforeEach(() => {
    localStorage.clear();
    storage.write({
      schemaVersion: 1,
      sessionToken: 'token-1',
      updatedAt: new Date().toISOString(),
    });
  });

  it('persists the exact body/key before dispatch and replays the same intent after network uncertainty', async () => {
    const intent = prepareOrder(storage, body);
    const api = {
      createOrder: vi.fn().mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce(order),
    } as unknown as CheckoutApi;
    expect(pendingOrder(storage)).toEqual(intent);
    await expect(sendOrderIntent(storage, api, intent)).rejects.toBeInstanceOf(NetworkError);
    expect(pendingOrder(storage)).toEqual({ ...intent, phase: 'outcomeUnknown' });
    expect(prepareOrder(storage, { ...body, paymentMethod: 'card' }).idempotencyKey).toBe(
      intent.idempotencyKey,
    );
    await expect(sendOrderIntent(storage, api, pendingOrder(storage)!)).resolves.toBe(order);
    expect(api.createOrder).toHaveBeenNthCalledWith(1, JSON.stringify(body), intent.idempotencyKey);
    expect(api.createOrder).toHaveBeenNthCalledWith(2, JSON.stringify(body), intent.idempotencyKey);
    expect(storage.read()?.pendingMutation).toBeUndefined();
    expect(storage.read()?.currentOrderId).toBe(order.id);
    expect(prepareOrder(storage, body).idempotencyKey).not.toBe(intent.idempotencyKey);
  });

  it.each(['QUOTE_EXPIRED', 'QUOTE_NOT_FOUND', 'CART_VERSION_CONFLICT', 'VALIDATION_ERROR'])(
    'clears known rejection %s',
    async (code) => {
      const intent = prepareOrder(storage, body);
      const api = {
        createOrder: vi.fn().mockRejectedValue(new HttpApiError(409, code, code, undefined, 'req')),
      } as unknown as CheckoutApi;
      await expect(sendOrderIntent(storage, api, intent)).rejects.toBeInstanceOf(HttpApiError);
      expect(pendingOrder(storage)).toBeNull();
    },
  );

  it('preserves a conflicting key for explicit reconciliation', async () => {
    const intent = prepareOrder(storage, body);
    const api = {
      createOrder: vi
        .fn()
        .mockRejectedValue(
          new HttpApiError(409, 'IDEMPOTENCY_CONFLICT', 'Conflict', undefined, 'req'),
        ),
    } as unknown as CheckoutApi;
    await expect(sendOrderIntent(storage, api, intent)).rejects.toBeInstanceOf(HttpApiError);
    expect(pendingOrder(storage)).toEqual({ ...intent, phase: 'outcomeUnknown' });
  });
});
