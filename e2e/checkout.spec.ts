import { expect, test, type Page } from '@playwright/test';

type Recovery = { sessionToken: string; currentOrderId?: string; currentPaymentId?: string };

async function recovery(page: Page): Promise<Recovery> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('checkout-recovery')!));
}

async function apiData<T>(page: Page, path: string): Promise<T> {
  const { sessionToken } = await recovery(page);
  const response = await page.request.get(`http://127.0.0.1:4000${path}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data as T;
}

async function assertViewport(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
}

async function prepareCheckout(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Каталог и корзина' })).toBeVisible();
  await page.getByRole('button', { name: /Добавить «Настольная лампа/ }).click();
  await expect(page.getByRole('link', { name: 'Перейти к оформлению' })).toBeVisible();
  await page.getByRole('link', { name: 'Перейти к оформлению' }).click();
  await expect(page.getByRole('heading', { name: 'Доставка и расчёт' })).toBeVisible();
  await page.getByLabel('Имя').fill('Тестовый Покупатель');
  await page.getByLabel('Email').fill('buyer@example.test');
  await page.getByLabel('Телефон').fill('+79990000000');
  await page.getByLabel('Пункт выдачи').selectOption('point-center');
  await assertViewport(page);
  await page.getByRole('button', { name: 'Рассчитать доставку и итог' }).click();
  await expect(page.getByRole('heading', { name: 'Расчёт сервера' })).toBeVisible();
}

async function createCardOrder(page: Page) {
  await prepareCheckout(page);
  await page.getByRole('radio', { name: /Картой онлайн/ }).check();
  const button = page.getByRole('button', { name: 'Оформить заказ' });
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.getByRole('heading', { name: 'Оплата картой' })).toBeVisible();
  const { currentOrderId } = await recovery(page);
  expect(currentOrderId).toBeTruthy();
  const orders = await apiData<Array<{ id: string }>>(page, '/api/orders');
  expect(orders).toHaveLength(1);
  expect(orders[0].id).toBe(currentOrderId);
  return currentOrderId!;
}

async function selectCard(page: Page, scenario: 'success' | 'decline') {
  await page
    .getByRole('radio', {
      name:
        scenario === 'success' ? /Тестовая карта: успешная оплата/ : /Тестовая карта: отказ банка/,
    })
    .check();
}

async function createPayment(page: Page, scenario: 'success' | 'decline') {
  await selectCard(page, scenario);
  const button = page.getByRole('button', { name: 'Создать попытку оплаты' });
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.getByRole('button', { name: 'Оплатить тестовой картой' })).toBeVisible();
  const { currentPaymentId } = await recovery(page);
  expect(currentPaymentId).toBeTruthy();
  return currentPaymentId!;
}

async function expectOrderPaid(page: Page, orderId: string) {
  await expect(
    page.getByRole('heading', { name: 'Оплата подтверждена — заказ оплачен' }),
  ).toBeVisible();
  const order = await apiData<{ status: string; paymentStatus: string }>(
    page,
    `/api/orders/${orderId}`,
  );
  expect(order).toMatchObject({ status: 'paid', paymentStatus: 'succeeded' });
}

test('card success waits for authoritative paid order', async ({ page }) => {
  const orderId = await createCardOrder(page);
  await createPayment(page, 'success');
  await assertViewport(page);
  await page.getByRole('button', { name: 'Оплатить тестовой картой' }).click();
  await expectOrderPaid(page, orderId);
});

test('declined card retries with a new payment on the same order', async ({ page }) => {
  const paymentKeys: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/orders\/[^/]+\/payments$/.test(request.url())) {
      paymentKeys.push(request.headers()['idempotency-key']);
    }
  });
  const orderId = await createCardOrder(page);
  const firstId = await createPayment(page, 'decline');
  await page.getByRole('button', { name: 'Оплатить тестовой картой' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'карта отклонена' })).toBeVisible();
  const first = await apiData<{ status: string }>(page, `/api/payments/${firstId}`);
  expect(first.status).toBe('failed');
  const secondId = await createPayment(page, 'success');
  expect(secondId).not.toBe(firstId);
  await page.getByRole('button', { name: 'Оплатить тестовой картой' }).click();
  await expectOrderPaid(page, orderId);
  const payments = await apiData<Array<{ id: string }>>(page, `/api/orders/${orderId}/payments`);
  expect(payments.map((payment) => payment.id)).toEqual([secondId, firstId]);
  expect(paymentKeys).toHaveLength(2);
  expect(paymentKeys[0]).toBeTruthy();
  expect(paymentKeys[1]).not.toBe(paymentKeys[0]);
});

test('cancel is terminal and permits a new attempt on the same order', async ({ page }) => {
  const orderId = await createCardOrder(page);
  const firstId = await createPayment(page, 'success');
  await page.getByRole('button', { name: 'Отменить оплату' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'оплата отменена' })).toBeVisible();
  expect((await apiData<{ status: string }>(page, `/api/payments/${firstId}`)).status).toBe(
    'cancelled',
  );
  const secondId = await createPayment(page, 'success');
  expect(secondId).not.toBe(firstId);
  const order = await apiData<{ id: string }>(page, `/api/orders/${orderId}`);
  expect(order.id).toBe(orderId);
});

test('reload recovers the known order and payment without duplicate intents', async ({ page }) => {
  const orderId = await createCardOrder(page);
  const paymentId = await createPayment(page, 'success');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Оплата картой' })).toBeVisible();
  expect((await recovery(page)).currentOrderId).toBe(orderId);
  expect((await recovery(page)).currentPaymentId).toBe(paymentId);
  await selectCard(page, 'success');
  await page.getByRole('button', { name: 'Оплатить тестовой картой' }).click();
  await expectOrderPaid(page, orderId);
  const payments = await apiData<Array<{ id: string }>>(page, `/api/orders/${orderId}/payments`);
  expect(payments).toHaveLength(1);
});

test('cash order completes without a payment', async ({ page }) => {
  await prepareCheckout(page);
  await page.getByRole('radio', { name: /Наличными при получении/ }).check();
  await page.getByRole('button', { name: 'Оформить заказ' }).click();
  await expect(
    page.getByRole('heading', { name: 'Заказ оформлен, оплата при получении' }),
  ).toBeVisible();
  const { currentOrderId } = await recovery(page);
  const order = await apiData<{ status: string; paymentStatus: string }>(
    page,
    `/api/orders/${currentOrderId}`,
  );
  expect(order).toMatchObject({ status: 'confirmed', paymentStatus: 'unpaid' });
  expect(await apiData<unknown[]>(page, `/api/orders/${currentOrderId}/payments`)).toHaveLength(0);
});

test('stale cart version rejects order and preserves safe customer fields', async ({ page }) => {
  await prepareCheckout(page);
  const { sessionToken } = await recovery(page);
  const response = await page.request.put('http://127.0.0.1:4000/api/cart/items/lamp-orbit', {
    headers: { Authorization: `Bearer ${sessionToken}` },
    data: { quantity: 2 },
  });
  expect(response.ok()).toBeTruthy();
  await page.getByRole('radio', { name: /Картой онлайн/ }).check();
  await page.getByRole('button', { name: 'Оформить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Расчёт сервера' })).toBeHidden();
  await expect(page.getByLabel('Имя')).toHaveValue('Тестовый Покупатель');
  await expect(page.getByLabel('Email')).toHaveValue('buyer@example.test');
  await expect(page.getByRole('button', { name: 'Рассчитать доставку и итог' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Оформить заказ' })).toBeHidden();
  await page.getByRole('button', { name: 'Рассчитать доставку и итог' }).click();
  await expect(page.getByRole('heading', { name: 'Расчёт сервера' })).toBeVisible();
});

test('keyboard form smoke exposes focus, radio, select, and validation errors', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Каталог и корзина' })).toBeVisible();
  await page.getByRole('button', { name: /Добавить «Настольная лампа/ }).click();
  await page.getByRole('link', { name: 'Перейти к оформлению' }).focus();
  await expect(page.getByRole('link', { name: 'Перейти к оформлению' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Доставка и расчёт' })).toBeVisible();

  const name = page.getByLabel('Имя');
  await name.focus();
  await expect(name).toBeFocused();
  await page.keyboard.type('Тестовый Покупатель');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type('buyer@example.test');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Телефон')).toBeFocused();
  await page.keyboard.type('+79990000000');
  const pickupRadio = page.getByRole('radio', { name: /Самовывоз/ });
  await pickupRadio.focus();
  await expect(pickupRadio).toBeFocused();
  await expect(pickupRadio).toBeChecked();
  const pickupSelect = page.getByLabel('Пункт выдачи');
  await pickupSelect.focus();
  await pickupSelect.press('End');
  await expect(pickupSelect).not.toHaveValue('');
  await page.getByRole('button', { name: 'Рассчитать доставку и итог' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Расчёт сервера' })).toBeVisible();
  const cardRadio = page.getByRole('radio', { name: /Картой онлайн/ });
  await cardRadio.focus();
  await page.keyboard.press('Space');
  await expect(cardRadio).toBeChecked();
  await expect(page.getByRole('button', { name: 'Оформить заказ' })).toBeEnabled();

  await page.getByLabel('Email').fill('invalid');
  await page.getByRole('button', { name: 'Оформить заказ' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Укажите корректный email.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
});
