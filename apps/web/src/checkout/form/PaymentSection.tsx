import type { Order, Payment, Scenario } from '@checkout/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { HttpApiError } from '../../api/errors';
import { queryKeys } from '../../lib/query-client';
import { checkoutApi, recoveryStorage } from '../../runtime';
import {
  pendingPayment,
  preparePayment,
  prepareSimulation,
  sendPaymentIntent,
  type PaymentIntent,
} from './payment-intent';
import styles from './CheckoutPage.module.css';

const terminal = (status: Payment['status']) =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';

export function PaymentSection({
  order,
  sessionScope,
  onOrderRefresh,
}: {
  order: Order;
  sessionScope: string;
  onOrderRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [intent, setIntent] = useState<PaymentIntent | null>(() =>
    pendingPayment(recoveryStorage, order.id),
  );
  const [cardId, setCardId] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [pollDelay, setPollDelay] = useState(750);
  const sending = useRef(false);
  const simulating = useRef(false);
  const settledId = useRef<string | null>(null);
  const sandbox = useQuery({
    queryKey: ['public', 'sandbox'],
    queryFn: ({ signal }) => checkoutApi.getSandbox(signal),
    enabled: order.status !== 'paid',
  });
  const payments = useQuery({
    queryKey: queryKeys.payments(sessionScope, order.id),
    queryFn: ({ signal }) => checkoutApi.listPayments(order.id, signal),
  });
  const latest = payments.data?.[0];
  const payment = useQuery({
    queryKey: queryKeys.payment(sessionScope, latest?.id ?? ''),
    queryFn: ({ signal }) => checkoutApi.getPayment(latest!.id, signal),
    enabled: Boolean(latest) && !intent,
    refetchInterval: (query) => (query.state.data?.status === 'processing' ? pollDelay : false),
  });
  const current = payment.data?.id === latest?.id ? payment.data : latest;
  const simulationIntent = recoveryStorage.read()?.pendingSimulation;

  useEffect(() => {
    if (!latest || intent) return;
    const record = recoveryStorage.read();
    if (
      record?.sessionToken &&
      record.currentOrderId === order.id &&
      record.currentPaymentId !== latest.id
    ) {
      recoveryStorage.write({
        ...record,
        currentPaymentId: latest.id,
        updatedAt: new Date().toISOString(),
      });
    }
  }, [latest, intent, order.id]);

  useEffect(() => {
    if (
      current &&
      latest &&
      current.id === latest.id &&
      terminal(current.status) &&
      settledId.current !== current.id
    ) {
      settledId.current = current.id;
      onOrderRefresh();
    }
  }, [current, latest, onOrderRefresh]);

  const simulation = useMutation({
    retry: false,
    mutationFn: ({ paymentId, scenario }: { paymentId: string; scenario: Scenario }) =>
      checkoutApi.simulatePayment(paymentId, scenario),
    onSuccess: async ({ retryAfterMs, simulation: result }, { paymentId }) => {
      setPollDelay(retryAfterMs);
      await queryClient.invalidateQueries({ queryKey: queryKeys.payment(sessionScope, paymentId) });
      if (terminal(result.status)) onOrderRefresh();
    },
    onSettled: () => {
      simulating.current = false;
    },
  });
  const creation = useMutation({
    retry: false,
    mutationFn: (prepared: PaymentIntent) =>
      sendPaymentIntent(recoveryStorage, checkoutApi, prepared),
    onSuccess: async (created) => {
      queryClient.setQueryData<Payment[]>(
        queryKeys.payments(sessionScope, order.id),
        (existing) => [created, ...(existing?.filter((item) => item.id !== created.id) ?? [])],
      );
      queryClient.setQueryData(queryKeys.payment(sessionScope, created.id), created);
      setIntent(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.payments(sessionScope, order.id) });
      onOrderRefresh();
    },
    onError: async () => {
      setIntent(pendingPayment(recoveryStorage, order.id));
      await queryClient.invalidateQueries({ queryKey: queryKeys.payments(sessionScope, order.id) });
      onOrderRefresh();
    },
    onSettled: () => {
      sending.current = false;
    },
  });

  function startSimulation(paymentId: string, scenario: Scenario) {
    if (simulating.current) return;
    simulating.current = true;
    try {
      prepareSimulation(recoveryStorage, paymentId, scenario);
      setLocalError(null);
      simulation.mutate({ paymentId, scenario });
    } catch (error) {
      simulating.current = false;
      setLocalError(
        error instanceof Error ? error.message : 'Не удалось сохранить сценарий оплаты.',
      );
    }
  }

  function create() {
    if (
      sending.current ||
      intent ||
      creation.isPending ||
      simulation.isPending ||
      !sandbox.data?.cards.some((card) => card.id === cardId)
    )
      return;
    sending.current = true;
    try {
      const prepared = preparePayment(recoveryStorage, order.id);
      setIntent(prepared);
      creation.mutate(prepared);
    } catch (error) {
      sending.current = false;
      setLocalError(
        error instanceof Error ? error.message : 'Не удалось сохранить попытку оплаты.',
      );
    }
  }

  function replay() {
    if (sending.current) return;
    const saved = pendingPayment(recoveryStorage, order.id);
    if (!saved) {
      setLocalError('Сохранённый запрос оплаты недоступен.');
      return;
    }
    sending.current = true;
    creation.mutate(saved);
  }

  const paid = order.status === 'paid' && order.paymentStatus === 'succeeded';
  const canCreate =
    !intent &&
    !paid &&
    !creation.isPending &&
    !simulation.isPending &&
    (!current || terminal(current.status)) &&
    order.paymentStatus !== 'pending';
  const canSimulate =
    !intent && current?.status === 'pending' && !simulation.isPending && !creation.isPending;

  return (
    <section className={styles.quote} aria-labelledby="card-payment-title" aria-live="polite">
      <p className={styles.sectionNumber}>05 · Тестовая оплата</p>
      <h2 id="card-payment-title">Оплата картой</h2>
      {paid ? <p role="status">Сервер подтвердил оплату заказа.</p> : null}
      {payments.isPending ? <p role="status">Восстанавливаем попытки оплаты…</p> : null}
      {payments.isError ? (
        <div className={styles.errorNotice} role="alert">
          <p>Не удалось загрузить попытки оплаты.</p>
          <button type="button" onClick={() => void payments.refetch()}>
            Повторить
          </button>
        </div>
      ) : null}
      {payment.isError && !intent ? (
        <div className={styles.errorNotice} role="alert">
          <p>Не удалось проверить статус оплаты.</p>
          <button type="button" onClick={() => void payment.refetch()}>
            Повторить
          </button>
        </div>
      ) : null}
      {current && !intent ? (
        <p role="status">
          Попытка {current.id}:{' '}
          {current.status === 'processing'
            ? 'обрабатывается, ожидаем сервер…'
            : current.status === 'pending'
              ? 'ожидает тестовый сценарий'
              : current.status === 'failed'
                ? 'карта отклонена; можно оплатить этот же заказ новой попыткой'
                : current.status === 'cancelled'
                  ? 'оплата отменена; можно оплатить этот же заказ новой попыткой'
                  : paid
                    ? 'оплата подтверждена заказом'
                    : 'оплата выполнена, проверяем заказ'}
          .
        </p>
      ) : null}
      {intent ? (
        <div className={styles.errorNotice} role="alert">
          <p>
            {creation.isPending
              ? 'Создаём попытку оплаты…'
              : creation.error instanceof HttpApiError &&
                  creation.error.code === 'IDEMPOTENCY_CONFLICT'
                ? 'Конфликт ключа: исход не подтверждён. Сохранённый ключ не изменён; обратитесь в поддержку.'
                : 'Исход создания оплаты неизвестен. Повторите сохранённый запрос с прежним ключом и телом.'}
          </p>
          {!creation.isPending ? (
            <button type="button" onClick={replay}>
              Повторить запрос
            </button>
          ) : null}
        </div>
      ) : null}
      {creation.isError && !intent ? (
        <div className={styles.errorNotice} role="alert">
          <p>
            {creation.error instanceof Error
              ? creation.error.message
              : 'Не удалось создать оплату.'}
          </p>
          <button
            type="button"
            onClick={() => {
              void payments.refetch();
              onOrderRefresh();
            }}
          >
            Обновить статус
          </button>
        </div>
      ) : null}
      {simulation.isError ? (
        <div className={styles.errorNotice} role="alert">
          <p>
            {simulation.error instanceof Error
              ? simulation.error.message
              : 'Не удалось запустить оплату.'}{' '}
            Проверьте статус или повторите тот же сценарий.
          </p>
          <button
            type="button"
            onClick={() => {
              void payment.refetch();
              onOrderRefresh();
            }}
          >
            Проверить статус
          </button>
        </div>
      ) : null}
      {localError ? (
        <p className={styles.errorNotice} role="alert">
          {localError}
        </p>
      ) : null}
      {!paid &&
      !intent &&
      !payments.isPending &&
      !payments.isError &&
      (canCreate || canSimulate) ? (
        <>
          {sandbox.isPending ? <p role="status">Загружаем тестовые карты…</p> : null}
          {sandbox.isError ? (
            <div className={styles.errorNotice} role="alert">
              <p>Тестовые карты недоступны.</p>
              <button type="button" onClick={() => void sandbox.refetch()}>
                Повторить
              </button>
            </div>
          ) : null}
          <fieldset
            className={styles.section}
            disabled={
              sandbox.isPending ||
              sandbox.isError ||
              Boolean(
                current?.status === 'pending' &&
                simulationIntent &&
                current.id === simulationIntent.paymentId,
              )
            }
          >
            <legend>Тестовая карта</legend>
            <div className={styles.deliveryChoices}>
              {sandbox.data?.cards.map((card) => (
                <label className={styles.deliveryChoice} key={card.id}>
                  <input
                    type="radio"
                    name="testCard"
                    value={card.id}
                    checked={cardId === card.id}
                    onChange={() => setCardId(card.id)}
                  />
                  <span>
                    <strong>{card.title}</strong>
                    <small>{card.maskedNumber}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {canCreate ? (
            <button
              className={styles.submitButton}
              type="button"
              disabled={
                !cardId ||
                !sandbox.data?.cards.some((card) => card.id === cardId) ||
                payment.isFetching
              }
              onClick={create}
            >
              Создать попытку оплаты
            </button>
          ) : null}
          {canSimulate ? (
            <>
              <button
                className={styles.submitButton}
                type="button"
                disabled={
                  Boolean(simulationIntent && current?.id === simulationIntent.paymentId) ||
                  !cardId ||
                  !sandbox.data?.cards.some((card) => card.id === cardId)
                }
                onClick={() => {
                  const selected = sandbox.data?.cards.find((card) => card.id === cardId);
                  if (selected) startSimulation(current!.id, selected.scenario);
                }}
              >
                Оплатить тестовой картой
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={Boolean(simulationIntent && current?.id === simulationIntent.paymentId)}
                onClick={() => startSimulation(current!.id, 'cancel')}
              >
                Отменить оплату
              </button>
              {simulationIntent?.paymentId === current?.id ? (
                <button
                  className={styles.submitButton}
                  type="button"
                  onClick={() => startSimulation(current.id, simulationIntent.scenario)}
                >
                  Повторить сохранённый сценарий
                </button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {current?.status === 'processing' ? (
        <p className={styles.hint}>
          Сценарий уже запущен; изменить его во время обработки нельзя. Опрос остановится после
          результата или ухода со страницы.
        </p>
      ) : null}
      {current?.status === 'succeeded' && !paid ? (
        <button type="button" className={styles.submitButton} onClick={onOrderRefresh}>
          Проверить подтверждение заказа
        </button>
      ) : null}
    </section>
  );
}
