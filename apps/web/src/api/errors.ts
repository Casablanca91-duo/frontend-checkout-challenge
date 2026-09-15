import type { ApiError as ApiErrorResponse } from '@checkout/contracts';

export type ApiFieldError = NonNullable<ApiErrorResponse['error']['fields']>[number];

export class HttpApiError extends Error {
  readonly kind = 'api';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: ApiFieldError[] | undefined,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'HttpApiError';
  }
}

export class NetworkError extends Error {
  readonly kind = 'network';

  constructor(message = 'Не удалось связаться с сервером.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export class RequestAbortedError extends Error {
  readonly kind = 'aborted';

  constructor(options?: ErrorOptions) {
    super('Запрос отменён.', options);
    this.name = 'RequestAbortedError';
  }
}

export class ProtocolError extends Error {
  readonly kind = 'protocol';

  constructor(message = 'Сервер вернул ответ неизвестного формата.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolError';
  }
}

export type CheckoutRequestError =
  HttpApiError | NetworkError | RequestAbortedError | ProtocolError;

export function isSessionInvalid(error: unknown): error is HttpApiError {
  return error instanceof HttpApiError && error.status === 401 && error.code === 'SESSION_INVALID';
}
