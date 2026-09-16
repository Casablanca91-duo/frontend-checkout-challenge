import type { CreateOrder, Order } from '@checkout/contracts';
import { HttpApiError } from '../../api/errors';
import type { CheckoutApi } from '../../api/checkout-api';
import type { CheckoutRecovery, RecoveryStorage } from '../../lib/storage';

export type OrderIntent = NonNullable<CheckoutRecovery['pendingMutation']>;

function updateRecovery(
  storage: RecoveryStorage,
  change: (record: CheckoutRecovery) => CheckoutRecovery,
) {
  const record = storage.read();
  if (!record?.sessionToken) throw new Error('Сессия оформления недоступна.');
  storage.write({ ...change(record), updatedAt: new Date().toISOString() });
}

export function prepareOrder(storage: RecoveryStorage, body: CreateOrder): OrderIntent {
  const record = storage.read();
  if (!record?.sessionToken) throw new Error('Сессия оформления недоступна.');
  if (record.pendingMutation) return record.pendingMutation;
  const intent: OrderIntent = {
    operation: 'createOrder',
    payload: JSON.stringify(body),
    idempotencyKey: crypto.randomUUID(),
    scope: record.sessionToken,
    quoteId: body.quoteId,
    phase: 'prepared',
    createdAt: new Date().toISOString(),
  };
  updateRecovery(storage, (current) => ({ ...current, pendingMutation: intent }));
  return intent;
}

export function pendingOrder(storage: RecoveryStorage): OrderIntent | null {
  const record = storage.read();
  return record?.pendingMutation && record.pendingMutation.scope === record.sessionToken
    ? record.pendingMutation
    : null;
}

export async function sendOrderIntent(
  storage: RecoveryStorage,
  api: CheckoutApi,
  intent: OrderIntent,
): Promise<Order> {
  if (pendingOrder(storage)?.idempotencyKey !== intent.idempotencyKey) {
    throw new Error('Сохранённый запрос заказа больше не совпадает с текущей сессией.');
  }
  updateRecovery(storage, (record) => ({
    ...record,
    pendingMutation: { ...intent, phase: 'inFlight' },
  }));
  try {
    const order = await api.createOrder(intent.payload, intent.idempotencyKey);
    updateRecovery(storage, (record) => {
      const { pendingMutation: _completed, ...rest } = record;
      return { ...rest, currentOrderId: order.id };
    });
    return order;
  } catch (error) {
    if (
      error instanceof HttpApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.code !== 'IDEMPOTENCY_CONFLICT'
    ) {
      updateRecovery(storage, (record) => {
        const { pendingMutation: _rejected, ...rest } = record;
        return rest;
      });
    } else {
      updateRecovery(storage, (record) => ({
        ...record,
        pendingMutation: { ...intent, phase: 'outcomeUnknown' },
      }));
    }
    throw error;
  }
}
