import type { Order, Payment } from '@checkout/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckoutQueryClient, queryKeys } from '../../lib/query-client';
import type { CheckoutRecovery } from '../../lib/storage';
import { PaymentSection } from './PaymentSection';

const api = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  listPayments: vi.fn(),
  getPayment: vi.fn(),
  createPayment: vi.fn(),
  simulatePayment: vi.fn(),
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

const order = {
  id: '00000000-0000-4000-8000-000000000005',
  status: 'awaiting_payment',
  paymentStatus: 'unpaid',
  paymentMethod: 'card',
} as Order;
const attempt = {
  id: '00000000-0000-4000-8000-000000000006',
  orderId: order.id,
  status: 'pending',
  amount: 100,
  currency: 'RUB',
  failureCode: null,
} as Payment;
const sandbox = {
  settlementDelayMs: 1200,
  cards: [
    { id: 'ok', title: 'Успешная', maskedNumber: '**** 1111', scenario: 'success' },
    { id: 'no', title: 'Отказ', maskedNumber: '**** 0002', scenario: 'decline' },
  ],
};

function show(currentOrder = order) {
  const onOrderRefresh = vi.fn();
  const queryClient = createCheckoutQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PaymentSection order={currentOrder} sessionScope="scope" onOrderRefresh={onOrderRefresh} />
    </QueryClientProvider>,
  );
  return { ...view, onOrderRefresh, queryClient };
}

describe('card payment', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    recovery.write({
      schemaVersion: 1,
      sessionToken: 'token',
      currentOrderId: order.id,
      updatedAt: new Date().toISOString(),
    });
    api.getSandbox.mockResolvedValue(sandbox);
    api.listPayments.mockResolvedValue([]);
    api.getPayment.mockResolvedValue(attempt);
    api.createPayment.mockResolvedValue(attempt);
    api.simulatePayment.mockResolvedValue({
      simulation: { id: 'sim', paymentId: attempt.id, scenario: 'success', status: 'processing' },
      retryAfterMs: 1000,
    });
  });

  it('uses only sandbox cards; persists Payment before send and blocks a double click', async () => {
    let resolve!: (value: Payment) => void;
    api.createPayment.mockImplementation(
      () =>
        new Promise<Payment>((done) => {
          resolve = done;
        }),
    );
    show();
    fireEvent.click(await screen.findByRole('radio', { name: /Успешная/ }));
    const button = screen.getByRole('button', { name: 'Создать попытку оплаты' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(api.createPayment).toHaveBeenCalledOnce());
    expect(recovery.read()?.pendingPayment).toMatchObject({
      payload: '{}',
      orderId: order.id,
      phase: 'inFlight',
    });
    expect(screen.queryByLabelText(/номер карты|CVC/i)).not.toBeInTheDocument();
    api.listPayments.mockResolvedValue([attempt]);
    resolve(attempt);
    const pay = await screen.findByRole('button', { name: 'Оплатить тестовой картой' });
    fireEvent.click(pay);
    fireEvent.click(pay);
    await waitFor(() => expect(api.simulatePayment).toHaveBeenCalledWith(attempt.id, 'success'));
    expect(api.simulatePayment).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['failed', 'отклонена'],
    ['cancelled', 'отменена'],
  ] as const)(
    'distinguishes %s and allows a fresh attempt on the same order',
    async (status, label) => {
      recovery.write({
        schemaVersion: 1,
        sessionToken: 'token',
        currentOrderId: order.id,
        currentPaymentId: attempt.id,
        pendingSimulation: { paymentId: attempt.id, scenario: 'decline' },
        updatedAt: new Date().toISOString(),
      });
      api.listPayments.mockResolvedValue([{ ...attempt, status }]);
      api.getPayment.mockResolvedValue({ ...attempt, status });
      show({ ...order, paymentStatus: status });
      expect(await screen.findByText(new RegExp(label))).toBeInTheDocument();
      const successCard = screen.getByRole('radio', { name: /Успешная/ });
      expect(successCard).toBeEnabled();
      fireEvent.click(successCard);
      fireEvent.click(screen.getByRole('button', { name: 'Создать попытку оплаты' }));
      await waitFor(() =>
        expect(api.createPayment).toHaveBeenCalledWith(order.id, '{}', expect.any(String)),
      );
    },
  );

  it('recovers a pending simulation after reload and replays only the saved scenario', async () => {
    recovery.write({
      schemaVersion: 1,
      sessionToken: 'token',
      currentOrderId: order.id,
      currentPaymentId: attempt.id,
      pendingSimulation: { paymentId: attempt.id, scenario: 'cancel' },
      updatedAt: new Date().toISOString(),
    });
    api.listPayments.mockResolvedValue([attempt]);
    show({ ...order, paymentStatus: 'pending' });
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить сохранённый сценарий' }));
    await waitFor(() => expect(api.simulatePayment).toHaveBeenCalledWith(attempt.id, 'cancel'));
  });

  it('requires authoritative paid Order before showing confirmation', async () => {
    api.listPayments.mockResolvedValue([{ ...attempt, status: 'succeeded' }]);
    api.getPayment.mockResolvedValue({ ...attempt, status: 'succeeded' });
    const { onOrderRefresh } = show({ ...order, paymentStatus: 'pending' });
    expect(await screen.findByText(/оплата выполнена, проверяем заказ/)).toBeInTheDocument();
    expect(screen.queryByText('Сервер подтвердил оплату заказа.')).not.toBeInTheDocument();
    await waitFor(() => expect(onOrderRefresh).toHaveBeenCalled());
  });

  it('polls processing until terminal, then stops after unmount', async () => {
    api.listPayments.mockResolvedValue([{ ...attempt, status: 'processing' }]);
    api.getPayment
      .mockResolvedValueOnce({ ...attempt, status: 'processing' })
      .mockResolvedValue({ ...attempt, status: 'failed' });
    const { unmount, onOrderRefresh } = show({ ...order, paymentStatus: 'pending' });
    expect(await screen.findByText(/обрабатывается, ожидаем сервер/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/карта отклонена/)).toBeInTheDocument(), {
      timeout: 2500,
    });
    expect(onOrderRefresh).toHaveBeenCalled();
    unmount();
    const calls = api.getPayment.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(api.getPayment).toHaveBeenCalledTimes(calls);
  });

  it('ignores a late response for an older payment after the latest ID changes', async () => {
    const newer = {
      ...attempt,
      id: '00000000-0000-4000-8000-000000000007',
      status: 'processing' as const,
    };
    let finishOld!: (value: Payment) => void;
    api.listPayments.mockResolvedValue([attempt]);
    api.getPayment.mockImplementation((id: string) =>
      id === attempt.id
        ? new Promise<Payment>((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve(newer),
    );
    const { queryClient } = show({ ...order, paymentStatus: 'pending' });
    await waitFor(() => expect(api.getPayment).toHaveBeenCalledWith(attempt.id, expect.anything()));
    queryClient.setQueryData(queryKeys.payments('scope', order.id), [newer, attempt]);
    expect(await screen.findByText(new RegExp(newer.id))).toBeInTheDocument();
    finishOld({ ...attempt, status: 'failed' });
    await waitFor(() =>
      expect(screen.getByText(new RegExp(newer.id))).toHaveTextContent('обрабатывается'),
    );
    expect(screen.queryByText(/карта отклонена/)).not.toBeInTheDocument();
  });
});
