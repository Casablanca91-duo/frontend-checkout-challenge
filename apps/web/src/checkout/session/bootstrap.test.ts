import type { Cart } from '@checkout/contracts';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionApi, SessionPayload } from '../../api/checkout-api';
import { HttpApiError, NetworkError } from '../../api/errors';
import { queryKeys } from '../../lib/query-client';
import type { CheckoutRecovery, RecoveryStorage } from '../../lib/storage';
import { bootstrapSession } from './bootstrap';

const cart: Cart = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 0,
  items: [],
  quantity: 0,
  subtotal: 0,
  currency: 'RUB',
};
const session: SessionPayload = {
  id: '00000000-0000-4000-8000-000000000002',
  token: '00000000-0000-4000-8000-000000000003',
  cart,
};

function recovery(token = 'existing-token'): CheckoutRecovery {
  return { schemaVersion: 1, sessionToken: token, updatedAt: '2026-09-15T10:00:00.000Z' };
}

function makeHarness(stored: CheckoutRecovery | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const recoveryStorage: RecoveryStorage = {
    read: vi.fn(() => stored),
    write: vi.fn(),
    clear: vi.fn(),
  };
  const tokenAccess = { set: vi.fn() };
  const api: SessionApi = {
    createSession: vi.fn(async () => session),
    getCart: vi.fn(async () => cart),
  };
  return { api, queryClient, recoveryStorage, tokenAccess };
}

describe('session bootstrap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a missing session, persists token first, and seeds canonical Cart cache', async () => {
    const harness = makeHarness(null);

    const ready = await bootstrapSession({
      ...harness,
      createSessionScope: () => 'scope-new',
      now: () => new Date('2026-09-15T11:00:00.000Z'),
    });

    expect(harness.api.createSession).toHaveBeenCalledOnce();
    expect(harness.api.getCart).not.toHaveBeenCalled();
    expect(harness.recoveryStorage.write).toHaveBeenCalledWith({
      schemaVersion: 1,
      sessionToken: session.token,
      updatedAt: '2026-09-15T11:00:00.000Z',
    });
    expect(harness.queryClient.getQueryData(queryKeys.cart('scope-new'))).toBe(cart);
    expect(ready).toEqual({ status: 'ready', sessionScope: 'scope-new' });
  });

  it('validates an existing token without creating a session and seeds Cart cache', async () => {
    const harness = makeHarness(recovery());

    const ready = await bootstrapSession({
      ...harness,
      createSessionScope: () => 'scope-existing',
    });

    expect(harness.tokenAccess.set).toHaveBeenNthCalledWith(1, 'existing-token');
    expect(harness.api.getCart).toHaveBeenCalledOnce();
    expect(harness.api.createSession).not.toHaveBeenCalled();
    expect(harness.queryClient.getQueryData(queryKeys.cart('scope-existing'))).toBe(cart);
    expect(ready.status).toBe('ready');
  });

  it('clears old authenticated state only for explicit SESSION_INVALID, then creates a session', async () => {
    const harness = makeHarness(recovery());
    harness.queryClient.setQueryData(queryKeys.cart('scope-old'), { ...cart, version: 5 });
    vi.mocked(harness.api.getCart).mockRejectedValueOnce(
      new HttpApiError(401, 'SESSION_INVALID', 'Invalid session', undefined, 'request-invalid'),
    );

    await bootstrapSession({ ...harness, createSessionScope: () => 'scope-replacement' });

    expect(harness.recoveryStorage.clear).toHaveBeenCalledOnce();
    expect(harness.queryClient.getQueryData(queryKeys.cart('scope-old'))).toBeUndefined();
    expect(harness.api.createSession).toHaveBeenCalledOnce();
    expect(harness.queryClient.getQueryData(queryKeys.cart('scope-replacement'))).toBe(cart);
  });

  it('preserves an existing token on network failure and retries validation before creating', async () => {
    const saved = recovery();
    const harness = makeHarness(saved);
    vi.mocked(harness.api.getCart)
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(cart);

    await expect(bootstrapSession(harness)).rejects.toBeInstanceOf(NetworkError);
    expect(harness.recoveryStorage.clear).not.toHaveBeenCalled();
    expect(harness.recoveryStorage.write).not.toHaveBeenCalled();
    expect(harness.api.createSession).not.toHaveBeenCalled();

    await expect(
      bootstrapSession({ ...harness, createSessionScope: () => 'scope-retry' }),
    ).resolves.toEqual({ status: 'ready', sessionScope: 'scope-retry' });
    expect(harness.api.getCart).toHaveBeenCalledTimes(2);
    expect(harness.api.createSession).not.toHaveBeenCalled();
    expect(harness.tokenAccess.set).toHaveBeenLastCalledWith(saved.sessionToken ?? null);
  });

  it('also preserves an existing token on a 5xx API error', async () => {
    const harness = makeHarness(recovery());
    vi.mocked(harness.api.getCart).mockRejectedValueOnce(
      new HttpApiError(500, 'INTERNAL_ERROR', 'Server error', undefined, 'request-500'),
    );

    await expect(bootstrapSession(harness)).rejects.toMatchObject({ status: 500 });
    expect(harness.recoveryStorage.clear).not.toHaveBeenCalled();
    expect(harness.api.createSession).not.toHaveBeenCalled();
  });
});
