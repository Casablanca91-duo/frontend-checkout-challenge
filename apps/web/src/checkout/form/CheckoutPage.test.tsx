import type { Cart, Quote } from '@checkout/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpApiError, NetworkError } from '../../api/errors';
import { createCheckoutQueryClient, queryKeys } from '../../lib/query-client';
import { CheckoutPage } from './CheckoutPage';
import { checkoutOptionsQueryOptions } from './queries';

const api = vi.hoisted(() => ({
  getCheckoutOptions: vi.fn(),
  getCart: vi.fn(),
  createQuote: vi.fn(),
}));

vi.mock('../../runtime', () => ({ checkoutApi: api }));

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

function renderCheckout(initialCart = cart) {
  api.getCart.mockResolvedValue(initialCart);
  api.getCheckoutOptions.mockResolvedValue({ ...options, cart: initialCart });
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

describe('Checkout Page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses one session-scoped Checkout Options key', () => {
    expect(checkoutOptionsQueryOptions('scope-1').queryKey).toEqual([
      'session',
      'scope-1',
      'checkout-options',
    ]);
  });

  it('uses the canonical Cart version and exact pickup payload', async () => {
    api.createQuote.mockResolvedValue(quote);
    renderCheckout();
    await fillPickup();

    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать доставку и итог' }));

    await waitFor(() =>
      expect(api.createQuote).toHaveBeenCalledWith(7, {
        method: 'pickup',
        pickupPointId: 'point-center',
      }),
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
      expect(api.createQuote).toHaveBeenCalledWith(7, {
        method: 'courier',
        address: { city: 'Учебный', street: 'Примерная', house: '10', apartment: '1' },
      }),
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
