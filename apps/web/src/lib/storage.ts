export const RECOVERY_SCHEMA_VERSION = 1 as const;
export const RECOVERY_STORAGE_KEY = 'checkout-recovery';

export type CheckoutRecovery = {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  sessionToken?: string;
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
      (typeof record.sessionToken === 'string' && record.sessionToken.length > 0))
  );
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
