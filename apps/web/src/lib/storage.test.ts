import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRecoveryStorage,
  RECOVERY_SCHEMA_VERSION,
  RECOVERY_STORAGE_KEY,
  type CheckoutRecovery,
} from './storage';

describe('recovery storage', () => {
  beforeEach(() => localStorage.clear());

  it('returns null for empty storage', () => {
    expect(createRecoveryStorage(localStorage).read()).toBeNull();
  });

  it('returns a valid current-version record', () => {
    const record: CheckoutRecovery = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      sessionToken: 'token-1',
      updatedAt: '2026-09-15T10:00:00.000Z',
    };
    localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(record));

    expect(createRecoveryStorage(localStorage).read()).toEqual(record);
  });

  it('accepts a persisted Payment intent and rejects a corrupted body', () => {
    const record: CheckoutRecovery = {
      schemaVersion: 1,
      sessionToken: 'token-1',
      currentOrderId: 'order-1',
      pendingPayment: {
        operation: 'createPayment',
        orderId: 'order-1',
        payload: '{}',
        idempotencyKey: 'key-1',
        scope: 'token-1',
        phase: 'outcomeUnknown',
        createdAt: '2026-09-15T10:00:00.000Z',
      },
      updatedAt: '2026-09-15T10:00:00.000Z',
    };
    localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(record));
    expect(createRecoveryStorage(localStorage).read()?.pendingPayment).toEqual(
      record.pendingPayment,
    );
    localStorage.setItem(
      RECOVERY_STORAGE_KEY,
      JSON.stringify({
        ...record,
        pendingPayment: { ...record.pendingPayment, payload: '{"other":true}' },
      }),
    );
    expect(createRecoveryStorage(localStorage).read()).toBeNull();
  });

  it.each(['{', JSON.stringify({ schemaVersion: 99, updatedAt: '2026-09-15T10:00:00.000Z' })])(
    'safely rejects corrupted or unsupported data',
    (raw) => {
      localStorage.setItem(RECOVERY_STORAGE_KEY, raw);
      expect(createRecoveryStorage(localStorage).read()).toBeNull();
    },
  );

  it('returns null when the browser blocks storage access', () => {
    const blockedStorage = {
      getItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: localStorage.setItem.bind(localStorage),
      removeItem: localStorage.removeItem.bind(localStorage),
    };

    expect(createRecoveryStorage(blockedStorage).read()).toBeNull();
  });

  it('writes the whole record and clears it', () => {
    const storage = createRecoveryStorage(localStorage);
    const record: CheckoutRecovery = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      sessionToken: 'token-2',
      updatedAt: '2026-09-15T10:00:00.000Z',
    };

    storage.write(record);
    expect(JSON.parse(localStorage.getItem(RECOVERY_STORAGE_KEY) ?? '')).toEqual(record);
    storage.clear();
    expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });
});
