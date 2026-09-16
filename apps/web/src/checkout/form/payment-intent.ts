import type { Payment, Scenario } from '@checkout/contracts';
import type { CheckoutApi } from '../../api/checkout-api';
import { HttpApiError } from '../../api/errors';
import type { CheckoutRecovery, RecoveryStorage } from '../../lib/storage';

export type PaymentIntent = NonNullable<CheckoutRecovery['pendingPayment']>;

function update(storage: RecoveryStorage, change: (record: CheckoutRecovery) => CheckoutRecovery) {
  const record = storage.read();
  if (!record?.sessionToken) throw new Error('Сессия оформления недоступна.');
  storage.write({ ...change(record), updatedAt: new Date().toISOString() });
}

export function pendingPayment(storage: RecoveryStorage, orderId: string): PaymentIntent | null {
  const record = storage.read();
  const intent = record?.pendingPayment;
  return intent && intent.orderId === orderId && intent.scope === record.sessionToken
    ? intent
    : null;
}

export function preparePayment(storage: RecoveryStorage, orderId: string): PaymentIntent {
  const record = storage.read();
  if (!record?.sessionToken || record.currentOrderId !== orderId || record.pendingMutation)
    throw new Error('Заказ или сессия недоступны для оплаты.');
  if (record.pendingPayment) {
    const existing = pendingPayment(storage, orderId);
    if (!existing) throw new Error('Другая попытка оплаты ещё не разрешена.');
    return existing;
  }
  const intent: PaymentIntent = {
    operation: 'createPayment',
    orderId,
    payload: '{}',
    idempotencyKey: crypto.randomUUID(),
    scope: record.sessionToken,
    phase: 'prepared',
    createdAt: new Date().toISOString(),
  };
  update(storage, (current) => ({
    ...current,
    currentPaymentId: undefined,
    pendingSimulation: undefined,
    pendingPayment: intent,
  }));
  return intent;
}

export async function sendPaymentIntent(
  storage: RecoveryStorage,
  api: CheckoutApi,
  intent: PaymentIntent,
): Promise<Payment> {
  if (pendingPayment(storage, intent.orderId)?.idempotencyKey !== intent.idempotencyKey)
    throw new Error('Сохранённая попытка оплаты не совпадает с текущей сессией.');
  update(storage, (current) => ({ ...current, pendingPayment: { ...intent, phase: 'inFlight' } }));
  try {
    const payment = await api.createPayment(intent.orderId, intent.payload, intent.idempotencyKey);
    update(storage, (current) => {
      const { pendingPayment: _done, ...rest } = current;
      return { ...rest, currentPaymentId: payment.id };
    });
    return payment;
  } catch (error) {
    if (
      error instanceof HttpApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.code !== 'IDEMPOTENCY_CONFLICT'
    ) {
      update(storage, (current) => {
        const { pendingPayment: _rejected, ...rest } = current;
        return rest;
      });
    } else {
      update(storage, (current) => ({
        ...current,
        pendingPayment: { ...intent, phase: 'outcomeUnknown' },
      }));
    }
    throw error;
  }
}

export function prepareSimulation(storage: RecoveryStorage, paymentId: string, scenario: Scenario) {
  const record = storage.read();
  if (!record?.sessionToken || record.currentPaymentId !== paymentId || record.pendingPayment)
    throw new Error('Попытка оплаты недоступна.');
  const existing = record.pendingSimulation;
  if (existing && (existing.paymentId !== paymentId || existing.scenario !== scenario))
    throw new Error('Для этой попытки уже выбран другой сценарий.');
  update(storage, (current) => ({ ...current, pendingSimulation: { paymentId, scenario } }));
}
