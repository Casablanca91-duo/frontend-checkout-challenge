import type { ApiResult } from '@checkout/contracts';
import {
  HttpApiError,
  NetworkError,
  ProtocolError,
  RequestAbortedError,
  type ApiFieldError,
} from './errors';

type FetchImplementation = typeof fetch;
type AuthMode = 'public' | 'session';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

type CommonRequestOptions = {
  path: string;
  auth: AuthMode;
  idempotencyKey?: string;
  signal?: AbortSignal;
  serializedBody?: string;
};

type RequestOptions = CommonRequestOptions &
  (
    | { method: Extract<Method, 'GET' | 'DELETE'>; body?: never }
    | { method: Extract<Method, 'POST' | 'PUT'>; body?: unknown }
  );

type JsonRequestOptions = RequestOptions & { responseType?: 'json' };
type EmptyRequestOptions = RequestOptions & { responseType: 'empty' };

export type ApiClient = {
  request<T>(options: JsonRequestOptions): Promise<ApiResult<T> & { retryAfterMs?: number }>;
  request(options: EmptyRequestOptions): Promise<void>;
};

type ApiClientOptions = {
  baseUrl: string;
  getSessionToken: () => string | null;
  fetchImpl?: FetchImplementation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldError(value: unknown): value is ApiFieldError {
  return isRecord(value) && typeof value.path === 'string' && typeof value.message === 'string';
}

function parseSuccess<T>(value: unknown): ApiResult<T> {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, 'data') ||
    !isRecord(value.meta) ||
    typeof value.meta.requestId !== 'string' ||
    !isRecord(value.links)
  ) {
    throw new ProtocolError();
  }

  return value as ApiResult<T>;
}

function parseApiError(value: unknown, status: number): HttpApiError {
  if (
    !isRecord(value) ||
    !isRecord(value.error) ||
    typeof value.error.code !== 'string' ||
    typeof value.error.message !== 'string' ||
    !isRecord(value.meta) ||
    typeof value.meta.requestId !== 'string' ||
    (value.error.fields !== undefined &&
      (!Array.isArray(value.error.fields) || !value.error.fields.every(isFieldError)))
  ) {
    throw new ProtocolError('Сервер вернул ошибку неизвестного формата.');
  }

  const fields = value.error.fields as ApiFieldError[] | undefined;
  return new HttpApiError(
    status,
    value.error.code,
    value.error.message,
    fields,
    value.meta.requestId,
  );
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProtocolError('Сервер вернул некорректный JSON.', { cause: error });
  }
}

export function createApiClient({
  baseUrl,
  getSessionToken,
  fetchImpl = fetch,
}: ApiClientOptions): ApiClient {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  async function request<T>(
    options: JsonRequestOptions,
  ): Promise<ApiResult<T> & { retryAfterMs?: number }>;
  async function request(options: EmptyRequestOptions): Promise<void>;
  async function request<T>(
    options: JsonRequestOptions | EmptyRequestOptions,
  ): Promise<(ApiResult<T> & { retryAfterMs?: number }) | void> {
    if (!options.path.startsWith('/')) {
      throw new ProtocolError('API path должен быть относительным путём от корня.');
    }

    const headers = new Headers();
    if (options.body !== undefined || options.serializedBody !== undefined)
      headers.set('Content-Type', 'application/json');
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    if (options.auth === 'session') {
      const token = getSessionToken();
      if (!token) throw new ProtocolError('Для защищённого запроса отсутствует token сессии.');
      headers.set('Authorization', `Bearer ${token}`);
    }

    let response: Response;
    try {
      response = await fetchImpl(new URL(options.path, normalizedBaseUrl), {
        method: options.method,
        headers,
        body:
          options.serializedBody ??
          (options.body === undefined ? undefined : JSON.stringify(options.body)),
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new RequestAbortedError({ cause: error });
      }
      throw new NetworkError(undefined, { cause: error });
    }

    if (response.status === 204) {
      if (options.responseType !== 'empty') {
        throw new ProtocolError('Сервер не вернул ожидаемые данные.');
      }
      return;
    }

    const payload = await parseJson(response);
    if (!response.ok) throw parseApiError(payload, response.status);
    if (options.responseType === 'empty') {
      throw new ProtocolError('Сервер вернул тело там, где ожидался пустой ответ.');
    }
    const result = parseSuccess<T>(payload);
    const retryAfter = response.headers.get('Retry-After');
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    return {
      ...result,
      ...(response.status === 202 && Number.isFinite(seconds) && seconds >= 0
        ? { retryAfterMs: Math.min(seconds * 1000, 60_000) }
        : {}),
    };
  }

  return { request };
}
