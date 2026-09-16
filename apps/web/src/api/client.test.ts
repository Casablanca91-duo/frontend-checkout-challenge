import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { HttpApiError, NetworkError, ProtocolError, RequestAbortedError } from './errors';

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function success(data: unknown) {
  return { data, meta: { requestId: 'request-1' }, links: {} };
}

function makeClient(fetchImpl: typeof fetch, token: string | null = null) {
  return createApiClient({
    baseUrl: 'http://localhost:4000',
    getSessionToken: () => token,
    fetchImpl,
  });
}

describe('apiClient', () => {
  it('sends the persisted serialized Order bytes and key unchanged', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(success({ id: 'order-1' })));
    const body = '{"quoteId":"quote-1","customer":{"name":"Buyer"},"paymentMethod":"card"}';
    await makeClient(fetchImpl, 'token-1').request({
      path: '/api/orders',
      method: 'POST',
      auth: 'session',
      serializedBody: body,
      idempotencyKey: 'key-1',
    });
    const init = fetchImpl.mock.calls[0][1];
    expect(init?.body).toBe(body);
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('key-1');
  });
  it('returns the centralized success envelope including meta requestId', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success({ ok: true })));

    await expect(
      makeClient(fetchImpl).request<{ ok: boolean }>({
        path: '/api',
        method: 'GET',
        auth: 'public',
      }),
    ).resolves.toEqual(success({ ok: true }));
  });

  it('handles an expected 204 without parsing JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      makeClient(fetchImpl).request({
        path: '/api/cart/items/item',
        method: 'DELETE',
        auth: 'session',
        responseType: 'empty',
      }),
    ).rejects.toBeInstanceOf(ProtocolError);

    const authenticated = makeClient(fetchImpl, 'token-1');
    await expect(
      authenticated.request({
        path: '/api/cart/items/item',
        method: 'DELETE',
        auth: 'session',
        responseType: 'empty',
      }),
    ).resolves.toBeUndefined();
  });

  it('preserves backend API error details and field errors', async () => {
    const payload = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Проверьте поля.',
        fields: [{ path: 'body/email', message: 'invalid email' }],
      },
      meta: { requestId: 'request-error' },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(payload, { status: 400 }));

    const error = await makeClient(fetchImpl)
      .request({ path: '/api/sessions', method: 'POST', auth: 'public', body: {} })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HttpApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Проверьте поля.',
      fields: payload.error.fields,
      requestId: 'request-error',
    });
  });

  it('normalizes malformed JSON and malformed envelopes as protocol errors', async () => {
    const malformedJson = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    await expect(
      makeClient(malformedJson).request({ path: '/api', method: 'GET', auth: 'public' }),
    ).rejects.toBeInstanceOf(ProtocolError);

    const malformedEnvelope = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: {} }));
    await expect(
      makeClient(malformedEnvelope).request({ path: '/api', method: 'GET', auth: 'public' }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('distinguishes network failures from aborted requests', async () => {
    const networkFetch = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    await expect(
      makeClient(networkFetch).request({ path: '/api', method: 'GET', auth: 'public' }),
    ).rejects.toBeInstanceOf(NetworkError);

    const abortedFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(
      makeClient(abortedFetch).request({ path: '/api', method: 'GET', auth: 'public' }),
    ).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it('adds Authorization only for session requests', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(success({})));
    const client = makeClient(fetchImpl, 'session-token');

    await client.request({ path: '/api/cart', method: 'GET', auth: 'session' });
    const sessionHeaders = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(sessionHeaders.get('Authorization')).toBe('Bearer session-token');

    await client.request({ path: '/api/products', method: 'GET', auth: 'public' });
    const publicHeaders = new Headers(fetchImpl.mock.calls[1][1]?.headers);
    expect(publicHeaders.has('Authorization')).toBe(false);
  });

  it('sets JSON headers and serializes an empty object without adding a body to GET', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(success({})));
    const client = makeClient(fetchImpl);

    await client.request({ path: '/api/sessions', method: 'POST', auth: 'public', body: {} });
    const post = fetchImpl.mock.calls[0][1];
    expect(new Headers(post?.headers).get('Content-Type')).toBe('application/json');
    expect(post?.body).toBe('{}');

    await client.request({ path: '/api/products', method: 'GET', auth: 'public' });
    const get = fetchImpl.mock.calls[1][1];
    expect(new Headers(get?.headers).has('Content-Type')).toBe(false);
    expect(get?.body).toBeUndefined();
  });

  it('forwards Idempotency-Key and AbortSignal options', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success({})));
    const controller = new AbortController();

    await makeClient(fetchImpl, 'token').request({
      path: '/api/orders',
      method: 'POST',
      auth: 'session',
      body: {},
      idempotencyKey: 'stable-key',
      signal: controller.signal,
    });

    const init = fetchImpl.mock.calls[0][1];
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('stable-key');
    expect(init?.signal).toBe(controller.signal);
  });
});
