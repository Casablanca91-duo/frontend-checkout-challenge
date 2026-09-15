const rubFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
});

export function formatMoney(value: number, currency: string) {
  if (currency === 'RUB') return rubFormatter.format(value / 100);
  return `${value / 100} ${currency}`;
}
