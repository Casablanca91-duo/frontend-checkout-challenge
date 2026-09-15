import type { QueryClient } from '@tanstack/react-query';
import { isSessionInvalid } from '../../api/errors';
import type { SessionApi } from '../../api/checkout-api';
import { queryKeys } from '../../lib/query-client';
import type { RecoveryStorage } from '../../lib/storage';
import { RECOVERY_SCHEMA_VERSION } from '../../lib/storage';

export type SessionTokenAccess = {
  set(token: string | null): void;
};

export type SessionReady = {
  status: 'ready';
  sessionScope: string;
};

type BootstrapDependencies = {
  api: SessionApi;
  queryClient: QueryClient;
  recoveryStorage: RecoveryStorage;
  tokenAccess: SessionTokenAccess;
  createSessionScope?: () => string;
  now?: () => Date;
  signal?: AbortSignal;
};

export async function bootstrapSession({
  api,
  queryClient,
  recoveryStorage,
  tokenAccess,
  createSessionScope = () => crypto.randomUUID(),
  now = () => new Date(),
  signal,
}: BootstrapDependencies): Promise<SessionReady> {
  const recovery = recoveryStorage.read();
  const existingToken = recovery?.sessionToken ?? null;
  tokenAccess.set(existingToken);

  if (existingToken) {
    try {
      const cart = await api.getCart(signal);
      const sessionScope = createSessionScope();
      queryClient.setQueryData(queryKeys.cart(sessionScope), cart);
      return { status: 'ready', sessionScope };
    } catch (error) {
      if (!isSessionInvalid(error)) throw error;
      await queryClient.cancelQueries({ queryKey: queryKeys.authenticated });
      queryClient.removeQueries({ queryKey: queryKeys.authenticated });
      recoveryStorage.clear();
      tokenAccess.set(null);
    }
  }

  const session = await api.createSession(signal);
  recoveryStorage.write({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    sessionToken: session.token,
    updatedAt: now().toISOString(),
  });
  tokenAccess.set(session.token);
  const sessionScope = createSessionScope();
  queryClient.setQueryData(queryKeys.cart(sessionScope), session.cart);
  return { status: 'ready', sessionScope };
}
