import type { Payment } from '@checkout/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutApi } from '../../api/checkout-api';
import { HttpApiError, NetworkError } from '../../api/errors';
import { createRecoveryStorage } from '../../lib/storage';
import {
  pendingPayment,
  preparePayment,
  prepareSimulation,
  sendPaymentIntent,
} from './payment-intent';

const orderId = '00000000-0000-4000-8000-000000000005';
const payment = {
  id: '00000000-0000-4000-8000-000000000006',
  orderId,
  status: 'pending',
} as Payment;

describe('Payment intent', () => {
  const storage = createRecoveryStorage(localStorage);
  beforeEach(() => {
    localStorage.clear();
    storage.write({
      schemaVersion: 1,
      sessionToken: 'token-1',
      currentOrderId: orderId,
      updatedAt: new Date().toISOString(),
    });
  });

  it('persists exact empty body and key before dispatch; uncertain replay keeps both and stores payment ID on success', async () => {
    const intent = preparePayment(storage, orderId);
    const api = {
      createPayment: vi
        .fn()
        .mockRejectedValueOnce(new NetworkError())
        .mockResolvedValueOnce(payment),
    } as unknown as CheckoutApi;
    expect(intent.payload).toBe('{}');
    expect(pendingPayment(storage, orderId)).toEqual(intent);
    await expect(sendPaymentIntent(storage, api, intent)).rejects.toBeInstanceOf(NetworkError);
    expect(pendingPayment(storage, orderId)?.phase).toBe('outcomeUnknown');
    expect(preparePayment(storage, orderId).idempotencyKey).toBe(intent.idempotencyKey);
    await expect(sendPaymentIntent(storage, api, pendingPayment(storage, orderId)!)).resolves.toBe(
      payment,
    );
    expect(api.createPayment).toHaveBeenNthCalledWith(1, orderId, '{}', intent.idempotencyKey);
    expect(api.createPayment).toHaveBeenNthCalledWith(2, orderId, '{}', intent.idempotencyKey);
    expect(storage.read()?.currentPaymentId).toBe(payment.id);
    expect(pendingPayment(storage, orderId)).toBeNull();
    const newIntent = preparePayment(storage, orderId);
    expect(newIntent.idempotencyKey).not.toBe(intent.idempotencyKey);
    expect(newIntent.orderId).toBe(orderId);
  });

  it('clears known rejection but preserves a conflicting key', async () => {
    const intent = preparePayment(storage, orderId);
    const api = {
      createPayment: vi
        .fn()
        .mockRejectedValue(
          new HttpApiError(409, 'PAYMENT_IN_PROGRESS', 'active', undefined, 'req'),
        ),
    } as unknown as CheckoutApi;
    await expect(sendPaymentIntent(storage, api, intent)).rejects.toBeInstanceOf(HttpApiError);
    expect(pendingPayment(storage, orderId)).toBeNull();
    const next = preparePayment(storage, orderId);
    const conflict = {
      createPayment: vi
        .fn()
        .mockRejectedValue(
          new HttpApiError(409, 'IDEMPOTENCY_CONFLICT', 'conflict', undefined, 'req'),
        ),
    } as unknown as CheckoutApi;
    await expect(sendPaymentIntent(storage, conflict, next)).rejects.toBeInstanceOf(HttpApiError);
    expect(pendingPayment(storage, orderId)?.idempotencyKey).toBe(next.idempotencyKey);
  });

  it('persists one scenario and refuses to switch it on the same payment', () => {
    const intent = preparePayment(storage, orderId);
    const api = { createPayment: vi.fn().mockResolvedValue(payment) } as unknown as CheckoutApi;
    return sendPaymentIntent(storage, api, intent).then(() => {
      prepareSimulation(storage, payment.id, 'decline');
      expect(storage.read()?.pendingSimulation).toEqual({
        paymentId: payment.id,
        scenario: 'decline',
      });
      expect(() => prepareSimulation(storage, payment.id, 'success')).toThrow();
      prepareSimulation(storage, payment.id, 'decline');
    });
  });
});
