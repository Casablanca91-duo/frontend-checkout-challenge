import type { Delivery } from '@checkout/contracts';
import { HttpApiError } from '../../api/errors';

export type CheckoutFormValues = {
  name: string;
  email: string;
  phone: string;
  deliveryMethod: Delivery['method'];
  pickupPointId: string;
  city: string;
  street: string;
  house: string;
  apartment: string;
};

export type CheckoutField = keyof CheckoutFormValues;
export type CheckoutFieldErrors = Partial<Record<CheckoutField, string>>;

export const initialCheckoutValues: CheckoutFormValues = {
  name: '',
  email: '',
  phone: '',
  deliveryMethod: 'pickup',
  pickupPointId: '',
  city: '',
  street: '',
  house: '',
  apartment: '',
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+[1-9]\d{9,14}$/;

export function validateCheckout(values: CheckoutFormValues): CheckoutFieldErrors {
  const errors: CheckoutFieldErrors = {};
  const name = values.name.trim();
  if (name.length < 2) errors.name = 'Укажите имя — минимум 2 символа.';
  else if (name.length > 100) errors.name = 'Имя должно быть не длиннее 100 символов.';

  if (!emailPattern.test(values.email.trim())) errors.email = 'Укажите корректный email.';
  else if (values.email.length > 150) errors.email = 'Email должен быть не длиннее 150 символов.';

  if (!phonePattern.test(values.phone.trim())) {
    errors.phone = 'Введите «+» и от 10 до 15 цифр, например +79990000000.';
  }

  if (values.deliveryMethod === 'pickup') {
    if (!values.pickupPointId) errors.pickupPointId = 'Выберите пункт выдачи.';
  } else {
    if (values.city.trim().length < 2) errors.city = 'Укажите город — минимум 2 символа.';
    if (values.street.trim().length < 2) errors.street = 'Укажите улицу — минимум 2 символа.';
    if (!values.house.trim()) errors.house = 'Укажите дом.';
  }
  return errors;
}

export function deliveryFromValues(values: CheckoutFormValues): Delivery {
  if (values.deliveryMethod === 'pickup') {
    return { method: 'pickup', pickupPointId: values.pickupPointId };
  }
  const apartment = values.apartment.trim();
  return {
    method: 'courier',
    address: {
      city: values.city.trim(),
      street: values.street.trim(),
      house: values.house.trim(),
      ...(apartment ? { apartment } : {}),
    },
  };
}

const serverPathToField: Array<[string, CheckoutField]> = [
  ['/delivery/pickupPointId', 'pickupPointId'],
  ['/delivery/address/city', 'city'],
  ['/delivery/address/street', 'street'],
  ['/delivery/address/house', 'house'],
  ['/delivery/address/apartment', 'apartment'],
  ['/customer/name', 'name'],
  ['/customer/email', 'email'],
  ['/customer/phone', 'phone'],
];

export function fieldErrorsFromApi(error: unknown): CheckoutFieldErrors {
  if (!(error instanceof HttpApiError) || !error.fields) return {};
  const result: CheckoutFieldErrors = {};
  for (const issue of error.fields) {
    const match = serverPathToField.find(([suffix]) => issue.path.endsWith(suffix));
    if (match && result[match[1]] === undefined) result[match[1]] = issue.message;
  }
  return result;
}

export function firstInvalidField(errors: CheckoutFieldErrors): CheckoutField | undefined {
  const order: CheckoutField[] = [
    'name',
    'email',
    'phone',
    'pickupPointId',
    'city',
    'street',
    'house',
    'apartment',
  ];
  return order.find((field) => errors[field]);
}
