import { createApiClient } from './api/client';
import { createCheckoutApi } from './api/checkout-api';
import { sessionCredential } from './lib/session-credential';
import { createRecoveryStorage } from './lib/storage';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export const recoveryStorage = createRecoveryStorage(window.localStorage);
export const apiClient = createApiClient({
  baseUrl: apiBaseUrl,
  getSessionToken: sessionCredential.get,
});
export const checkoutApi = createCheckoutApi(apiClient);
