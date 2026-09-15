import { describe, expect, it } from 'vitest';
import {
  deliveryFromValues,
  initialCheckoutValues,
  validateCheckout,
  type CheckoutFormValues,
} from './form-model';

const validCustomer = {
  name: 'Тестовый Покупатель',
  email: 'buyer@example.test',
  phone: '+79990000000',
};

function values(overrides: Partial<CheckoutFormValues> = {}): CheckoutFormValues {
  return { ...initialCheckoutValues, ...validCustomer, ...overrides };
}

describe('checkout form model', () => {
  it('builds the exact pickup payload and does not require courier fields', () => {
    const pickup = values({ pickupPointId: 'point-center' });

    expect(validateCheckout(pickup)).toEqual({});
    expect(deliveryFromValues(pickup)).toEqual({
      method: 'pickup',
      pickupPointId: 'point-center',
    });
  });

  it('requires pickupPointId only for pickup', () => {
    expect(validateCheckout(values())).toMatchObject({ pickupPointId: expect.any(String) });
    expect(
      validateCheckout(
        values({ deliveryMethod: 'courier', city: 'Москва', street: 'Тверская', house: '1' }),
      ),
    ).not.toHaveProperty('pickupPointId');
  });

  it('requires courier address only for courier and omits an empty apartment', () => {
    const incomplete = values({ deliveryMethod: 'courier' });
    expect(validateCheckout(incomplete)).toMatchObject({
      city: expect.any(String),
      street: expect.any(String),
      house: expect.any(String),
    });

    const courier = values({
      deliveryMethod: 'courier',
      city: ' Учебный ',
      street: ' Примерная ',
      house: ' 10 ',
      apartment: ' ',
    });
    expect(deliveryFromValues(courier)).toEqual({
      method: 'courier',
      address: { city: 'Учебный', street: 'Примерная', house: '10' },
    });
  });
});
