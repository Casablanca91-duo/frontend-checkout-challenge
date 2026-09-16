import type { Cart, Order, Quote } from '@checkout/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpApiError, NetworkError } from '../../api/errors';
import type { CheckoutOptions } from '../../api/checkout-api';
import { createCheckoutQueryClient, queryKeys } from '../../lib/query-client';
import type { CheckoutRecovery } from '../../lib/storage';
import { CheckoutPage } from './CheckoutPage';
import { checkoutOptionsQueryOptions, quoteRequestSignature } from './queries';

const api = vi.hoisted(() => ({
  getCheckoutOptions: vi.fn(),
  getCart: vi.fn(),
  createQuote: vi.fn(),
  createOrder: vi.fn(),
  getOrder: vi.fn(),
  listOrders: vi.fn(),
}));

const recovery = vi.hoisted(() => {
  let record: CheckoutRecovery | null = null;
  return {
    read: vi.fn(() => record),
    write: vi.fn((next: CheckoutRecovery) => {
      record = next;
    }),
    clear: vi.fn(() => {
      record = null;
    }),
  };
});
vi.mock('../../runtime', () => ({ checkoutApi: api, recoveryStorage: recovery }));

const cart: Cart = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 7,
  items: [
    {
      productId: 'lamp-orbit',
      title: 'Лампа «Орбита»',
      unitPrice: 249000,
      quantity: 2,
      lineTotal: 498000,
    },
  ],
  quantity: 2,
  subtotal: 498000,
  currency: 'RUB',
};

const emptyCart: Cart = { ...cart, version: 0, items: [], quantity: 0, subtotal: 0 };
const options = {
  cart,
  deliveryMethods: [
    {
      id: 'pickup' as const,
      title: 'Самовывоз',
      price: 0,
      freeFrom: null,
      pickupPoints: [
        { id: 'point-center', title: 'Центр', address: 'Учебная, 1' },
        { id: 'point-north', title: 'Север', address: 'Примерная, 2' },
      ],
    },
    {
      id: 'courier' as const,
      title: 'Курьер',
      price: 39000,
      freeFrom: 500000,
      pickupPoints: [],
    },
  ],
  paymentMethods: [],
};

const quote: Quote = {
  id: '00000000-0000-4000-8000-000000000004',
  cartVersion: 7,
  items: [{ ...cart.items[0], lineTotal: 111100 }],
  delivery: { method: 'pickup', pickupPointId: 'point-center' },
  subtotal: 222200,
  shipping: 33300,
  total: 444400,
  currency: 'RUB',
  expiresAt: '2026-09-15T14:10:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderCheckout(
  initialCart = cart,
  paymentMethods: CheckoutOptions['paymentMethods'] = [],
) {
  api.getCart.mockResolvedValue(initialCart);
  api.getCheckoutOptions.mockResolvedValue({ ...options, cart: initialCart, paymentMethods });
  const queryClient = createCheckoutQueryClient();
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CheckoutPage sessionScope="scope-1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return queryClient;
}

function fillCustomer() {
  fireEvent.change(screen.getByLabelText(/Имя/), { target: { value: 'Тестовый Покупатель' } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'buyer@example.test' } });
  fireEvent.change(screen.getByLabelText(/Телефон/), { target: { value: '+79990000000' } });
}

async function fillPickup() {
  await screen.findByRole('option', { name: /Центр/ });
  fillCustomer();
  fireEvent.change(screen.getByLabelText(/Пункт выдачи/), {
    target: { value: 'point-center' },
  });
}

async function readyToOrder(method: 'card' | 'cash_on_delivery' = 'cash_on_delivery') {
  api.createQuote.mockResolvedValue(quote);
  renderCheckout(cart, [
    { id: 'card', title: 'Картой' },
    { id: 'cash_on_delivery', title: 'Наличными при получении' },
  ]);
  await fillPickup();
  fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));
  await screen.findByRole('heading', { name: 'Способ оплаты' });
  fireEvent.click(
    screen.getByRole('radio', { name: method === 'card' ? 'Картой' : 'Наличными при получении' }),
  );
}

const createdOrder: Order = {
  id: '00000000-0000-4000-8000-000000000005',
  number: 'DEMO-000001',
  status: 'confirmed',
  paymentStatus: 'unpaid',
  paymentMethod: 'cash_on_delivery',
  customer: { name: 'Тестовый Покупатель', email: 'buyer@example.test', phone: '+79990000000' },
  items: quote.items,
  delivery: quote.delivery,
  subtotal: quote.subtotal,
  shipping: quote.shipping,
  total: quote.total,
  currency: 'RUB',
  createdAt: '2026-09-15T14:00:00.000Z',
};

describe('Checkout Page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    recovery.write({
      schemaVersion: 1,
      sessionToken: 'token-1',
      updatedAt: new Date().toISOString(),
    });
  });

  it('uses one session-scoped Checkout Options key', () => {
    expect(checkoutOptionsQueryOptions('scope-1').queryKey).toEqual([
      'session',
      'scope-1',
      'checkout-options',
    ]);
  });

  it.each(['cash_on_delivery', 'card'] as const)(
    'creates %s Order using server-provided payment option and current Quote',
    async (method) => {
      const pending = deferred<Order>();
      api.createOrder.mockReturnValue(pending.promise);
      api.getCart.mockResolvedValueOnce(cart).mockResolvedValueOnce(emptyCart);
      await readyToOrder(method);
      const submitOrder = screen.getByRole('button', { name: 'Оформить заказ' });
      fireEvent.click(submitOrder);
      fireEvent.click(submitOrder);
      await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(1));
      const [serialized, key] = api.createOrder.mock.calls[0];
      expect(JSON.parse(serialized)).toEqual({
        quoteId: quote.id,
        customer: createdOrder.customer,
        paymentMethod: method,
      });
      expect(key).toBe(recovery.read()?.pendingMutation?.idempotencyKey);
      expect(recovery.read()?.pendingMutation?.payload).toBe(serialized);
      pending.resolve({
        ...createdOrder,
        paymentMethod: method,
        status: method === 'card' ? 'awaiting_payment' : 'confirmed',
      });
      await screen.findByText(
        method === 'card' ? 'Заказ создан, ожидает оплаты' : 'Заказ оформлен, оплата при получении',
      );
      expect(screen.getByText('DEMO-000001', { exact: false })).toBeInTheDocument();
      expect(screen.getByText(/Лампа «Орбита» × 2/)).toBeInTheDocument();
      expect(screen.getByText(/Самовывоз, пункт point-center/)).toBeInTheDocument();
      expect(recovery.read()?.currentOrderId).toBe(createdOrder.id);
      expect(recovery.read()?.pendingMutation).toBeUndefined();
      await waitFor(() => expect(api.getCart).toHaveBeenCalledTimes(2));
    },
  );

  it('recovers current Order from server rather than local Order data', async () => {
    recovery.write({
      schemaVersion: 1,
      sessionToken: 'token-1',
      currentOrderId: createdOrder.id,
      updatedAt: new Date().toISOString(),
    });
    api.getOrder.mockResolvedValue(createdOrder);
    renderCheckout(emptyCart);
    await screen.findByText('Заказ оформлен, оплата при получении');
    expect(api.getOrder).toHaveBeenCalledWith(createdOrder.id, expect.any(AbortSignal));
  });

  it.each(['QUOTE_EXPIRED', 'QUOTE_NOT_FOUND', 'CART_VERSION_CONFLICT'])(
    '%s clears the Quote intent and preserves form input',
    async (code) => {
      api.createOrder.mockRejectedValue(
        new HttpApiError(code === 'QUOTE_NOT_FOUND' ? 404 : 409, code, code, undefined, 'req'),
      );
      await readyToOrder();
      fireEvent.click(screen.getByRole('button', { name: 'Оформить заказ' }));
      await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(recovery.read()?.pendingMutation).toBeUndefined());
      expect(screen.getByLabelText(/Имя/)).toHaveValue('Тестовый Покупатель');
      expect(screen.queryByRole('heading', { name: 'Способ оплаты' })).not.toBeInTheDocument();
      expect(api.getCart).toHaveBeenCalledTimes(2);
    },
  );

  it('maps backend customer field errors to their controls', async () => {
    api.createOrder.mockRejectedValue(
      new HttpApiError(
        422,
        'VALIDATION_ERROR',
        'Invalid',
        [{ path: '/customer/email', message: 'Email отклонён сервером' }],
        'req',
      ),
    );
    await readyToOrder();
    fireEvent.click(screen.getByRole('button', { name: 'Оформить заказ' }));
    expect(await screen.findByText('Email отклонён сервером')).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Email/)).toHaveValue('buyer@example.test');
  });

  it('does not prepare or send an Order when customer validation fails', async () => {
    await readyToOrder();
    fireEvent.change(screen.getByLabelText(/Имя/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Оформить заказ' }));
    expect(screen.getByLabelText(/Имя/)).toHaveAttribute('aria-invalid', 'true');
    expect(api.createOrder).not.toHaveBeenCalled();
    expect(recovery.read()?.pendingMutation).toBeUndefined();
  });

  it('preserves the key and consults server orders on idempotency conflict without guessing an Order', async () => {
    api.createOrder.mockRejectedValue(
      new HttpApiError(409, 'IDEMPOTENCY_CONFLICT', 'Conflict', undefined, 'req'),
    );
    api.listOrders.mockResolvedValue([createdOrder]);
    await readyToOrder();
    fireEvent.click(screen.getByRole('button', { name: 'Оформить заказ' }));
    await screen.findByText(/На сервере найдено заказов в этой сессии: 1/);
    expect(api.listOrders).toHaveBeenCalledTimes(1);
    expect(recovery.read()?.pendingMutation?.phase).toBe('outcomeUnknown');
    expect(recovery.read()?.currentOrderId).toBeUndefined();
  });

  it('normalizes the Quote signature and includes the canonical Cart version', () => {
    const normalized = quoteRequestSignature({
      cartVersion: 7,
      delivery: {
        method: 'courier',
        address: { city: 'Учебный', street: 'Примерная', house: '10' },
      },
    });

    expect(
      quoteRequestSignature({
        cartVersion: 7,
        delivery: {
          method: 'courier',
          address: { city: ' Учебный ', street: ' Примерная ', house: ' 10 ', apartment: ' ' },
        },
      }),
    ).toBe(normalized);
    expect(
      quoteRequestSignature({
        cartVersion: 8,
        delivery: {
          method: 'courier',
          address: { city: 'Учебный', street: 'Примерная', house: '10' },
        },
      }),
    ).not.toBe(normalized);
  });

  it('uses the canonical Cart version and exact pickup payload', async () => {
    api.createQuote.mockResolvedValue(quote);
    renderCheckout();
    await fillPickup();

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));

    await waitFor(() =>
      expect(api.createQuote).toHaveBeenCalledWith(
        7,
        {
          method: 'pickup',
          pickupPointId: 'point-center',
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it('builds the courier contract and validates only its active fields', async () => {
    api.createQuote.mockResolvedValue({
      ...quote,
      delivery: {
        method: 'courier',
        address: { city: 'Учебный', street: 'Примерная', house: '10', apartment: '1' },
      },
    });
    renderCheckout();
    await screen.findByText('Самовывоз');
    fillCustomer();
    fireEvent.click(screen.getByRole('radio', { name: /Курьер/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));
    expect(await screen.findByText('Укажите город — минимум 2 символа.')).toBeInTheDocument();
    expect(screen.queryByText('Выберите пункт выдачи.')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Город/), { target: { value: 'Учебный' } });
    fireEvent.change(screen.getByLabelText(/Улица/), { target: { value: 'Примерная' } });
    fireEvent.change(screen.getByLabelText(/Дом/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Квартира/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));

    await waitFor(() =>
      expect(api.createQuote).toHaveBeenCalledWith(
        7,
        {
          method: 'courier',
          address: { city: 'Учебный', street: 'Примерная', house: '10', apartment: '1' },
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it('preserves customer and delivery values after a recoverable request error', async () => {
    api.createQuote.mockRejectedValue(new NetworkError());
    renderCheckout();
    await fillPickup();

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось связаться с сервером.');
    expect(screen.getByLabelText(/Имя/)).toHaveValue('Тестовый Покупатель');
    expect(screen.getByLabelText(/Пункт выдачи/)).toHaveValue('point-center');
  });

  it('associates server field errors with the matching delivery control', async () => {
    api.createQuote.mockRejectedValue(
      new HttpApiError(
        400,
        'VALIDATION_ERROR',
        'Проверьте поля.',
        [{ path: 'body/delivery/pickupPointId', message: 'Пункт больше недоступен.' }],
        'request-fields',
      ),
    );
    renderCheckout();
    await fillPickup();

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));

    const select = screen.getByLabelText(/Пункт выдачи/);
    expect(await screen.findByText('Пункт больше недоступен.')).toBeInTheDocument();
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Пункт больше недоступен.');
  });

  it('renders all Quote amounts from the response without recalculation', async () => {
    api.createQuote.mockResolvedValue(quote);
    renderCheckout();
    await fillPickup();
    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));

    const summary = await screen.findByRole('heading', { name: 'Расчёт сервера' });
    expect(summary.closest('section')).toHaveTextContent(/1.?111/);
    expect(summary.closest('section')).toHaveTextContent(/2.?222/);
    expect(summary.closest('section')).toHaveTextContent(/333/);
    expect(summary.closest('section')).toHaveTextContent(/4.?444/);
    expect(summary.closest('section')).not.toHaveTextContent(/4.?980/);
  });

  it('refreshes canonical Cart, discards Quote, and keeps form data on a version conflict', async () => {
    api.createQuote
      .mockResolvedValueOnce(quote)
      .mockRejectedValueOnce(
        new HttpApiError(
          409,
          'CART_VERSION_CONFLICT',
          'Версия корзины изменилась.',
          undefined,
          'request-conflict',
        ),
      );
    api.getCart.mockResolvedValueOnce(cart).mockResolvedValue({ ...cart, version: 8 });
    renderCheckout();
    await fillPickup();

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));
    expect(await screen.findByRole('heading', { name: 'Расчёт сервера' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));

    expect(await screen.findByText(/Корзина изменилась/)).toBeInTheDocument();
    await waitFor(() => expect(api.getCart).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'Расчёт сервера' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toHaveValue('buyer@example.test');
    expect(screen.getByRole('button', { name: 'Обновить данные' })).toBeEnabled();
  });

  it('blocks Quote creation for an empty Cart', async () => {
    renderCheckout(emptyCart);

    expect(await screen.findByText('Корзина пуста.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Рассчитать доставку и итог' })).toBeDisabled();
    expect(api.createQuote).not.toHaveBeenCalled();
  });

  it('blocks repeated submission while the Quote request is pending', async () => {
    let resolveQuote: ((value: Quote) => void) | undefined;
    api.createQuote.mockImplementation(
      () => new Promise<Quote>((resolve) => (resolveQuote = resolve)),
    );
    renderCheckout();
    await fillPickup();
    const submit = screen.getByRole('button', { name: 'Рассчитать доставку и итог' });

    fireEvent.click(submit);
    expect(await screen.findByRole('button', { name: 'Рассчитываем…' })).toBeDisabled();
    fireEvent.click(submit);
    expect(api.createQuote).toHaveBeenCalledOnce();
    resolveQuote?.(quote);
  });

  it('rejects a late Quote response after Delivery changes and accepts only the new signature', async () => {
    const first = deferred<Quote>();
    const second = deferred<Quote>();
    let firstSignal: AbortSignal | undefined;
    api.createQuote
      .mockImplementationOnce((_version, _delivery, signal: AbortSignal) => {
        firstSignal = signal;
        return first.promise;
      })
      .mockImplementationOnce(() => second.promise);
    const courierQuote: Quote = {
      ...quote,
      id: '00000000-0000-4000-8000-000000000005',
      delivery: {
        method: 'courier',
        address: { city: 'Учебный', street: 'Примерная', house: '10' },
      },
      shipping: 39000,
      total: 555500,
    };
    renderCheckout();
    await fillPickup();

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));
    await waitFor(() => expect(api.createQuote).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('radio', { name: /Курьер/ }));
    fireEvent.change(screen.getByLabelText(/Город/), { target: { value: 'Учебный' } });
    fireEvent.change(screen.getByLabelText(/Улица/), { target: { value: 'Примерная' } });
    fireEvent.change(screen.getByLabelText(/Дом/), { target: { value: '10' } });
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => first.resolve(quote));
    expect(screen.queryByRole('heading', { name: 'Расчёт сервера' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Рассчитать доставку и итог' })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));
    await waitFor(() => expect(api.createQuote).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(courierQuote));

    const accepted = await screen.findByRole('heading', { name: 'Расчёт сервера' });
    expect(accepted.closest('section')).toHaveTextContent(/5.?555/);
    expect(api.createQuote).toHaveBeenLastCalledWith(
      7,
      courierQuote.delivery,
      expect.any(AbortSignal),
    );
  });

  it('rejects a late Quote response after the canonical Cart version changes', async () => {
    const first = deferred<Quote>();
    const second = deferred<Quote>();
    let firstSignal: AbortSignal | undefined;
    api.createQuote
      .mockImplementationOnce((_version, _delivery, signal: AbortSignal) => {
        firstSignal = signal;
        return first.promise;
      })
      .mockImplementationOnce(() => second.promise);
    const nextCart = { ...cart, version: 8 };
    const nextQuote = {
      ...quote,
      id: '00000000-0000-4000-8000-000000000006',
      cartVersion: 8,
      total: 666600,
    };
    const queryClient = renderCheckout();
    await fillPickup();

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));
    await waitFor(() => expect(api.createQuote).toHaveBeenCalledOnce());
    act(() => queryClient.setQueryData(queryKeys.cart('scope-1'), nextCart));
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));

    await act(async () => first.resolve(quote));
    expect(screen.queryByRole('heading', { name: 'Расчёт сервера' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Рассчитать доставку и итог' })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));
    await waitFor(() => expect(api.createQuote).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(nextQuote));

    const accepted = await screen.findByRole('heading', { name: 'Расчёт сервера' });
    expect(accepted.closest('section')).toHaveTextContent('Версия корзины 8');
    expect(accepted.closest('section')).toHaveTextContent(/6.?666/);
    expect(api.createQuote).toHaveBeenLastCalledWith(
      8,
      { method: 'pickup', pickupPointId: 'point-center' },
      expect.any(AbortSignal),
    );
  });

  it('keeps automatic mutation retry disabled', () => {
    const client = createCheckoutQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('never uses Checkout Options cart as the canonical Cart entry', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    api.getCart.mockResolvedValue(cart);
    api.getCheckoutOptions.mockResolvedValue({ ...options, cart: { ...cart, version: 99 } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <CheckoutPage sessionScope="scope-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByText('Самовывоз');
    expect(queryClient.getQueryData(queryKeys.cart('scope-1'))).toEqual(cart);
  });
});
