import type { CreateOrder } from '@checkout/contracts';

export const RECOVERY_SCHEMA_VERSION = 1 as const;
export const RECOVERY_STORAGE_KEY = 'checkout-recovery';

export type CheckoutRecovery = {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  sessionToken?: string;
  currentOrderId?: string;
  currentPaymentId?: string;
  pendingPayment?: {
    operation: 'createPayment';
    orderId: string;
    payload: string;
    idempotencyKey: string;
    scope: string;
    phase: 'prepared' | 'inFlight' | 'outcomeUnknown';
    createdAt: string;
  };
  pendingSimulation?: { paymentId: string; scenario: 'success' | 'decline' | 'cancel' };
  pendingMutation?: {
    operation: 'createOrder';
    payload: string;
    idempotencyKey: string;
    scope: string;
    quoteId: CreateOrder['quoteId'];
    phase: 'prepared' | 'inFlight' | 'outcomeUnknown';
    createdAt: string;
  };
  updatedAt: string;
};

type StorageAdapter = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type RecoveryStorage = {
  read(): CheckoutRecovery | null;
  write(record: CheckoutRecovery): void;
  clear(): void;
};

function isRecovery(value: unknown): value is CheckoutRecovery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === RECOVERY_SCHEMA_VERSION &&
    typeof record.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(record.updatedAt)) &&
    (record.sessionToken === undefined ||
      (typeof record.sessionToken === 'string' && record.sessionToken.length > 0)) &&
    (record.currentOrderId === undefined || typeof record.currentOrderId === 'string') &&
    (record.currentPaymentId === undefined || typeof record.currentPaymentId === 'string') &&
    (record.pendingPayment === undefined || isPendingPayment(record.pendingPayment)) &&
    (record.pendingSimulation === undefined || isPendingSimulation(record.pendingSimulation)) &&
    (record.pendingMutation === undefined || isPendingMutation(record.pendingMutation))
  );
}

function isPendingPayment(
  value: unknown,
): value is NonNullable<CheckoutRecovery['pendingPayment']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return (
    intent.operation === 'createPayment' &&
    typeof intent.orderId === 'string' &&
    Boolean(intent.orderId) &&
    intent.payload === '{}' &&
    typeof intent.idempotencyKey === 'string' &&
    Boolean(intent.idempotencyKey) &&
    typeof intent.scope === 'string' &&
    Boolean(intent.scope) &&
    ['prepared', 'inFlight', 'outcomeUnknown'].includes(String(intent.phase)) &&
    typeof intent.createdAt === 'string' &&
    !Number.isNaN(Date.parse(intent.createdAt))
  );
}

function isPendingSimulation(
  value: unknown,
): value is NonNullable<CheckoutRecovery['pendingSimulation']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.paymentId === 'string' &&
    Boolean(record.paymentId) &&
    ['success', 'decline', 'cancel'].includes(String(record.scenario))
  );
}

function isPendingMutation(
  value: unknown,
): value is NonNullable<CheckoutRecovery['pendingMutation']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  if (
    intent.operation !== 'createOrder' ||
    typeof intent.payload !== 'string' ||
    typeof intent.idempotencyKey !== 'string' ||
    !intent.idempotencyKey ||
    typeof intent.scope !== 'string' ||
    !intent.scope ||
    typeof intent.quoteId !== 'string' ||
    !intent.quoteId ||
    !['prepared', 'inFlight', 'outcomeUnknown'].includes(String(intent.phase)) ||
    typeof intent.createdAt !== 'string' ||
    Number.isNaN(Date.parse(intent.createdAt))
  )
    return false;
  try {
    const body: unknown = JSON.parse(intent.payload);
    return (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).quoteId === intent.quoteId
    );
  } catch {
    return false;
  }
}

export function createRecoveryStorage(
  storage: StorageAdapter,
  key = RECOVERY_STORAGE_KEY,
): RecoveryStorage {
  return {
    read() {
      try {
        const raw = storage.getItem(key);
        if (raw === null) return null;
        const value: unknown = JSON.parse(raw);
        return isRecovery(value) ? value : null;
      } catch {
        return null;
      }
    },
    write(record) {
      storage.setItem(key, JSON.stringify(record));
    },
    clear() {
      storage.removeItem(key);
    },
  };
}
