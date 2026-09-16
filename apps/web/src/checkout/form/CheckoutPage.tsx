import type { CreateOrder, Order, Quote } from '@checkout/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { HttpApiError } from '../../api/errors';
import { formatMoney } from '../../lib/format';
import { queryKeys } from '../../lib/query-client';
import { checkoutApi, recoveryStorage } from '../../runtime';
import { cartQueryOptions } from '../catalog-cart/queries';
import styles from './CheckoutPage.module.css';
import { pendingOrder, prepareOrder, sendOrderIntent, type OrderIntent } from './order-intent';
import {
  deliveryFromValues,
  fieldErrorsFromApi,
  firstInvalidField,
  initialCheckoutValues,
  validateCheckout,
  type CheckoutField,
  type CheckoutFieldErrors,
  type CheckoutFormValues,
} from './form-model';
import {
  checkoutOptionsQueryOptions,
  needsCheckoutSync,
  quoteRequestSignature,
  useQuoteMutation,
} from './queries';

function inputId(field: CheckoutField) {
  return `checkout-${field}`;
}

type FieldProps = {
  field: CheckoutField;
  label: string;
  value: string;
  error?: string;
  type?: 'text' | 'email' | 'tel';
  autoComplete?: string;
  required?: boolean;
  onChange(field: CheckoutField, value: string): void;
};

function TextField({
  field,
  label,
  value,
  error,
  type = 'text',
  autoComplete,
  required = true,
  onChange,
}: FieldProps) {
  const id = inputId(field);
  const errorId = `${id}-error`;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>
        {label} {required ? <span aria-hidden="true">*</span> : null}
      </label>
      <input
        id={id}
        name={field}
        type={type}
        value={value}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(field, event.target.value)}
      />
      {error ? (
        <span className={styles.fieldError} id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function messageForError(error: unknown): string {
  if (error instanceof HttpApiError) {
    if (error.code === 'CART_VERSION_CONFLICT') {
      return 'Корзина изменилась. Мы обновили её — проверьте состав и повторите расчёт.';
    }
    if (error.code === 'CART_EMPTY') return 'Корзина пуста. Добавьте товар перед расчётом.';
    if (error.status === 404) return 'Данные оформления устарели. Обновите их и повторите.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Не удалось получить расчёт.';
}

function QuoteSummary({ quote }: { quote: Quote }) {
  return (
    <section className={styles.quote} aria-labelledby="quote-title" aria-live="polite">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.sectionNumber}>04</p>
          <h2 id="quote-title">Расчёт сервера</h2>
        </div>
        <span>Версия корзины {quote.cartVersion}</span>
      </div>
      <ul className={styles.quoteItems}>
        {quote.items.map((item) => (
          <li key={item.productId}>
            <span>
              {item.title} × {item.quantity}
            </span>
            <strong>{formatMoney(item.lineTotal, quote.currency)}</strong>
          </li>
        ))}
      </ul>
      <dl className={styles.totals}>
        <div>
          <dt>Товары</dt>
          <dd>{formatMoney(quote.subtotal, quote.currency)}</dd>
        </div>
        <div>
          <dt>Доставка</dt>
          <dd>{formatMoney(quote.shipping, quote.currency)}</dd>
        </div>
        <div className={styles.grandTotal}>
          <dt>Итого</dt>
          <dd>{formatMoney(quote.total, quote.currency)}</dd>
        </div>
      </dl>
      <p className={styles.expiry}>
        Расчёт действует до{' '}
        <time dateTime={quote.expiresAt}>
          {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(
            new Date(quote.expiresAt),
          )}
        </time>
        .
      </p>
    </section>
  );
}

function OrderSummary({ order }: { order: Order }) {
  return (
    <section className={styles.quote} aria-labelledby="order-title">
      <p className={styles.sectionNumber}>Заказ {order.number}</p>
      <h2 id="order-title">
        {order.paymentMethod === 'cash_on_delivery'
          ? 'Заказ оформлен, оплата при получении'
          : 'Заказ создан, ожидает оплаты'}
      </h2>
      <p>
        Статус заказа: {order.status}. Статус оплаты: {order.paymentStatus}.
      </p>
      <ul className={styles.quoteItems}>
        {order.items.map((item) => (
          <li key={item.productId}>
            <span>
              {item.title} × {item.quantity}
            </span>
            <strong>{formatMoney(item.lineTotal, order.currency)}</strong>
          </li>
        ))}
      </ul>
      <p>
        Доставка:{' '}
        {order.delivery.method === 'pickup'
          ? `Самовывоз, пункт ${order.delivery.pickupPointId}`
          : `Курьер, ${order.delivery.address.city}, ${order.delivery.address.street}, ${order.delivery.address.house}${order.delivery.address.apartment ? `, кв. ${order.delivery.address.apartment}` : ''}`}
      </p>
      <dl className={styles.totals}>
        <div>
          <dt>Товары</dt>
          <dd>{formatMoney(order.subtotal, order.currency)}</dd>
        </div>
        <div>
          <dt>Доставка</dt>
          <dd>{formatMoney(order.shipping, order.currency)}</dd>
        </div>
        <div className={styles.grandTotal}>
          <dt>Итого</dt>
          <dd>{formatMoney(order.total, order.currency)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function CheckoutPage({ sessionScope }: { sessionScope: string }) {
  const queryClient = useQueryClient();
  const cart = useQuery(cartQueryOptions(sessionScope));
  const options = useQuery(checkoutOptionsQueryOptions(sessionScope));
  const [values, setValues] = useState<CheckoutFormValues>(initialCheckoutValues);
  const [clientErrors, setClientErrors] = useState<CheckoutFieldErrors>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<CreateOrder['paymentMethod'] | ''>('');
  const [savedIntent, setSavedIntent] = useState<OrderIntent | null>(() =>
    pendingOrder(recoveryStorage),
  );
  const [orderId, setOrderId] = useState(() => recoveryStorage.read()?.currentOrderId ?? null);
  const [reconciliation, setReconciliation] = useState<Order[] | null>(null);
  const [reconciliationError, setReconciliationError] = useState(false);
  const sending = useRef(false);
  const order = useQuery({
    queryKey: queryKeys.order(sessionScope, orderId ?? ''),
    queryFn: ({ signal }) => checkoutApi.getOrder(orderId!, signal),
    enabled: Boolean(orderId),
  });
  const orderMutation = useMutation({
    retry: false,
    mutationFn: (intent: OrderIntent) => sendOrderIntent(recoveryStorage, checkoutApi, intent),
    onSuccess: async (created) => {
      setSavedIntent(null);
      setOrderId(created.id);
      queryClient.setQueryData(queryKeys.order(sessionScope, created.id), created);
      quoteMutation.invalidate();
      await queryClient.invalidateQueries({ queryKey: queryKeys.cart(sessionScope) });
    },
    onError: async (error) => {
      setSavedIntent(pendingOrder(recoveryStorage));
      if (error instanceof HttpApiError && error.code === 'IDEMPOTENCY_CONFLICT') {
        try {
          setReconciliation(await checkoutApi.listOrders());
          setReconciliationError(false);
        } catch {
          setReconciliationError(true);
        }
      }
      if (
        error instanceof HttpApiError &&
        error.status < 500 &&
        error.code !== 'IDEMPOTENCY_CONFLICT'
      ) {
        quoteMutation.invalidate();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.cart(sessionScope) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.checkoutOptions(sessionScope) }),
        ]);
      }
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  const currentQuoteSignature = cart.data
    ? quoteRequestSignature({
        cartVersion: cart.data.version,
        delivery: deliveryFromValues(values),
      })
    : null;
  const quoteMutation = useQuoteMutation(sessionScope, currentQuoteSignature, setQuote);
  const visibleQuote =
    quote &&
    currentQuoteSignature ===
      quoteRequestSignature({ cartVersion: quote.cartVersion, delivery: quote.delivery })
      ? quote
      : null;

  const serverErrors = useMemo(
    () => ({
      ...fieldErrorsFromApi(quoteMutation.error),
      ...fieldErrorsFromApi(orderMutation.error),
    }),
    [quoteMutation.error, orderMutation.error],
  );
  const errors = { ...serverErrors, ...clientErrors };

  function updateField(field: CheckoutField, value: string) {
    if (
      ['deliveryMethod', 'pickupPointId', 'city', 'street', 'house', 'apartment'].includes(field)
    ) {
      quoteMutation.invalidate();
    }
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) {
      setClientErrors((current) => ({ ...current, [field]: undefined }));
      if (serverErrors[field]) quoteMutation.reset();
      if (serverErrors[field]) orderMutation.reset();
    }
  }

  function focusFirstError(nextErrors: CheckoutFieldErrors) {
    const first = firstInvalidField(nextErrors);
    if (first) document.getElementById(inputId(first))?.focus();
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (quoteMutation.isPending || !cart.data || cart.data.items.length === 0) return;
    const nextErrors = validateCheckout(values);
    setClientErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      focusFirstError(nextErrors);
      return;
    }
    setQuote(null);
    quoteMutation.mutate({
      cartVersion: cart.data.version,
      delivery: deliveryFromValues(values),
    });
  }

  async function refreshCheckout() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.cart(sessionScope) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.checkoutOptions(sessionScope) }),
    ]);
    quoteMutation.reset();
  }

  function createOrder() {
    if (
      sending.current ||
      savedIntent ||
      orderId ||
      !visibleQuote ||
      !cart.data ||
      visibleQuote.cartVersion !== cart.data.version ||
      !options.data ||
      !options.data.paymentMethods.some((method) => method.id === paymentMethod)
    )
      return;
    const nextErrors = validateCheckout(values);
    setClientErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      focusFirstError(nextErrors);
      return;
    }
    sending.current = true;
    try {
      const intent = prepareOrder(recoveryStorage, {
        quoteId: visibleQuote.id,
        customer: {
          name: values.name.trim(),
          email: values.email.trim(),
          phone: values.phone.trim(),
        },
        paymentMethod: paymentMethod as CreateOrder['paymentMethod'],
      });
      setSavedIntent(intent);
      orderMutation.mutate(intent);
    } catch (error) {
      sending.current = false;
      setOrderPreparationError(
        error instanceof Error ? error.message : 'Не удалось сохранить заказ.',
      );
    }
  }

  const [orderPreparationError, setOrderPreparationError] = useState<string | null>(null);
  function retryOrder() {
    if (sending.current) return;
    const intent = pendingOrder(recoveryStorage);
    if (!intent) {
      setOrderPreparationError('Сохранённый запрос недоступен.');
      return;
    }
    setReconciliation(null);
    setReconciliationError(false);
    sending.current = true;
    orderMutation.mutate(intent);
  }

  function startNewOrder() {
    const record = recoveryStorage.read();
    if (!record || record.pendingMutation) return;
    const { currentOrderId: _previous, ...rest } = record;
    try {
      recoveryStorage.write({ ...rest, updatedAt: new Date().toISOString() });
      setOrderId(null);
      orderMutation.reset();
      setValues(initialCheckoutValues);
      setPaymentMethod('');
    } catch (error) {
      setOrderPreparationError(
        error instanceof Error ? error.message : 'Не удалось начать новый заказ.',
      );
    }
  }

  const pickup = options.data?.deliveryMethods.find((method) => method.id === 'pickup');
  const isEmpty = cart.data?.items.length === 0;
  const blocksQuote =
    !cart.data ||
    Boolean(isEmpty) ||
    cart.isError ||
    options.isError ||
    Boolean(savedIntent) ||
    Boolean(orderId);
  const syncError = needsCheckoutSync(quoteMutation.error);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Оформление заказа</p>
          <h1>Доставка и расчёт</h1>
        </div>
        <Link className={styles.backLink} to="/">
          ← Вернуться в корзину
        </Link>
      </header>

      <div className={styles.layout} hidden={Boolean(orderId)}>
        <form className={styles.form} noValidate onSubmit={submit}>
          <fieldset className={styles.section}>
            <legend>
              <span className={styles.sectionNumber}>01</span>
              Получатель
            </legend>
            <p className={styles.hint}>Эти данные сохранятся при ошибке расчёта.</p>
            <div className={styles.fieldGrid}>
              <TextField
                field="name"
                label="Имя"
                value={values.name}
                error={errors.name}
                autoComplete="name"
                onChange={updateField}
              />
              <TextField
                field="email"
                label="Email"
                value={values.email}
                error={errors.email}
                type="email"
                autoComplete="email"
                onChange={updateField}
              />
              <TextField
                field="phone"
                label="Телефон"
                value={values.phone}
                error={errors.phone}
                type="tel"
                autoComplete="tel"
                onChange={updateField}
              />
            </div>
          </fieldset>

          <fieldset className={styles.section} disabled={options.isPending}>
            <legend>
              <span className={styles.sectionNumber}>02</span>
              Способ доставки
            </legend>
            {options.isPending ? (
              <p className={styles.notice} aria-live="polite">
                Загружаем способы доставки…
              </p>
            ) : options.isError ? (
              <div className={styles.errorNotice} role="alert">
                <p>{messageForError(options.error)}</p>
                <button type="button" onClick={() => void options.refetch()}>
                  Повторить
                </button>
              </div>
            ) : (
              <>
                <div className={styles.deliveryChoices}>
                  {options.data?.deliveryMethods.map((method) => (
                    <label className={styles.deliveryChoice} key={method.id}>
                      <input
                        type="radio"
                        name="deliveryMethod"
                        value={method.id}
                        checked={values.deliveryMethod === method.id}
                        onChange={() => updateField('deliveryMethod', method.id)}
                      />
                      <span>
                        <strong>{method.title}</strong>
                        <small>
                          {method.price === 0
                            ? 'Бесплатно'
                            : `от ${formatMoney(method.price, 'RUB')}`}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>

                {values.deliveryMethod === 'pickup' ? (
                  <div className={styles.field}>
                    <label htmlFor={inputId('pickupPointId')}>
                      Пункт выдачи <span aria-hidden="true">*</span>
                    </label>
                    <select
                      id={inputId('pickupPointId')}
                      name="pickupPointId"
                      value={values.pickupPointId}
                      required
                      aria-invalid={Boolean(errors.pickupPointId)}
                      aria-describedby={
                        errors.pickupPointId ? 'checkout-pickupPointId-error' : undefined
                      }
                      onChange={(event) => updateField('pickupPointId', event.target.value)}
                    >
                      <option value="">Выберите пункт</option>
                      {pickup?.pickupPoints.map((point) => (
                        <option value={point.id} key={point.id}>
                          {point.title} — {point.address}
                        </option>
                      ))}
                    </select>
                    {errors.pickupPointId ? (
                      <span
                        className={styles.fieldError}
                        id="checkout-pickupPointId-error"
                        role="alert"
                      >
                        {errors.pickupPointId}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className={styles.addressGrid}>
                    <TextField
                      field="city"
                      label="Город"
                      value={values.city}
                      error={errors.city}
                      autoComplete="address-level2"
                      onChange={updateField}
                    />
                    <TextField
                      field="street"
                      label="Улица"
                      value={values.street}
                      error={errors.street}
                      autoComplete="address-line1"
                      onChange={updateField}
                    />
                    <TextField
                      field="house"
                      label="Дом"
                      value={values.house}
                      error={errors.house}
                      autoComplete="address-line2"
                      onChange={updateField}
                    />
                    <TextField
                      field="apartment"
                      label="Квартира"
                      value={values.apartment}
                      error={errors.apartment}
                      required={false}
                      onChange={updateField}
                    />
                  </div>
                )}
              </>
            )}
          </fieldset>

          <section className={styles.section} aria-labelledby="calculation-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.sectionNumber}>03</p>
                <h2 id="calculation-title">Получить итог</h2>
              </div>
            </div>
            {cart.isPending ? (
              <p className={styles.notice} aria-live="polite">
                Проверяем корзину…
              </p>
            ) : isEmpty ? (
              <div className={styles.emptyNotice} role="status">
                <p>Корзина пуста.</p>
                <Link to="/">Добавить товары</Link>
              </div>
            ) : cart.isError ? (
              <div className={styles.errorNotice} role="alert">
                <p>Не удалось подтвердить актуальную корзину.</p>
                <button type="button" onClick={() => void cart.refetch()}>
                  Повторить
                </button>
              </div>
            ) : null}

            {quoteMutation.isError ? (
              <div className={styles.errorNotice} role="alert">
                <p>{messageForError(quoteMutation.error)}</p>
                {syncError ? (
                  <button type="button" onClick={() => void refreshCheckout()}>
                    Обновить данные
                  </button>
                ) : null}
              </div>
            ) : null}

            <button
              className={styles.submitButton}
              type="submit"
              disabled={blocksQuote || quoteMutation.isPending}
            >
              {quoteMutation.isPending ? 'Рассчитываем…' : 'Рассчитать доставку и итог'}
            </button>
          </section>
        </form>

        <aside className={styles.summary} aria-label="Сводка корзины">
          <p className={styles.sectionNumber}>Корзина</p>
          <h2>{cart.data?.quantity ?? 0} шт.</h2>
          {cart.data ? (
            <p>
              Товары: <strong>{formatMoney(cart.data.subtotal, cart.data.currency)}</strong>
            </p>
          ) : (
            <p>Загружаем состав…</p>
          )}
          <p className={styles.hint}>Доставка и общий итог появятся только после ответа сервера.</p>
        </aside>
      </div>

      {orderId ? (
        order.isPending ? (
          <p role="status">Загружаем заказ с сервера…</p>
        ) : order.isError ? (
          <div className={styles.errorNotice} role="alert">
            <p>Не удалось получить заказ с сервера.</p>
            <button type="button" onClick={() => void order.refetch()}>
              Повторить
            </button>
          </div>
        ) : order.data ? (
          <>
            <OrderSummary order={order.data} />
            <p>
              <Link to="/" onClick={startNewOrder}>
                Перейти к новой покупке
              </Link>
            </p>
          </>
        ) : null
      ) : null}
      {!orderId && savedIntent ? (
        <section className={styles.quote} aria-live="polite">
          <h2>Проверка создания заказа</h2>
          <p>
            {orderMutation.isPending
              ? 'Отправляем сохранённый запрос…'
              : orderMutation.error instanceof HttpApiError &&
                  orderMutation.error.code === 'IDEMPOTENCY_CONFLICT'
                ? 'Конфликт ключа идемпотентности. Исход не подтверждён; сохранённый ключ не изменён. Обратитесь в поддержку, прежде чем оформлять другой заказ.'
                : 'Исход запроса неизвестен. Повторите сохранённый запрос с тем же ключом и данными.'}
          </p>
          {reconciliation ? (
            <p>
              На сервере найдено заказов в этой сессии: {reconciliation.length}. Данные заказа не
              содержат исходный ключ или Quote ID, поэтому автоматически определить соответствие
              нельзя.
            </p>
          ) : null}
          {reconciliationError ? (
            <p>
              Не удалось получить список заказов для сверки. Сохранённый запрос остаётся доступен.
            </p>
          ) : null}
          {!orderMutation.isPending && (
            <button className={styles.submitButton} type="button" onClick={retryOrder}>
              Повторить / сверить заказ
            </button>
          )}
        </section>
      ) : null}
      {orderPreparationError ? (
        <p className={styles.errorNotice} role="alert">
          {orderPreparationError}
        </p>
      ) : null}
      {!orderId && !savedIntent && orderMutation.isError ? (
        <div className={styles.errorNotice} role="alert">
          <p>{messageForError(orderMutation.error)}</p>
        </div>
      ) : null}
      {!orderId && !savedIntent && visibleQuote ? (
        <>
          <QuoteSummary quote={visibleQuote} />
          <section className={styles.quote} aria-labelledby="payment-title">
            <h2 id="payment-title">Способ оплаты</h2>
            <div className={styles.deliveryChoices}>
              {options.data?.paymentMethods.map((method) => (
                <label className={styles.deliveryChoice} key={method.id}>
                  <input
                    type="radio"
                    name="paymentMethod"
                    value={method.id}
                    checked={paymentMethod === method.id}
                    onChange={() => setPaymentMethod(method.id)}
                  />
                  <span>
                    <strong>{method.title}</strong>
                  </span>
                </label>
              ))}
            </div>
            <button
              className={styles.submitButton}
              type="button"
              disabled={
                !paymentMethod ||
                !options.data?.paymentMethods.some((method) => method.id === paymentMethod) ||
                orderMutation.isPending ||
                !cart.data ||
                visibleQuote.cartVersion !== cart.data.version
              }
              onClick={createOrder}
            >
              Оформить заказ
            </button>
          </section>
        </>
      ) : null}
    </main>
  );
}
