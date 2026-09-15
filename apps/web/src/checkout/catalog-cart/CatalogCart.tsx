import type { Cart, Product } from '@checkout/contracts';
import { useMemo } from 'react';
import { useCatalogCart } from './queries';
import styles from './CatalogCart.module.css';

const moneyFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
});

function formatMoney(value: number, currency: Cart['currency'] | Product['currency']) {
  if (currency === 'RUB') return moneyFormatter.format(value / 100);
  return `${value / 100} ${currency}`;
}

function ErrorNotice({ message, retry }: { message: string; retry(): void }) {
  return (
    <div className={styles.noticeError} role="alert">
      <p>{message}</p>
      <button className={styles.secondaryButton} type="button" onClick={retry}>
        Повторить
      </button>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function CatalogCart({ sessionScope }: { sessionScope: string }) {
  const { products, cart, mutation } = useCatalogCart(sessionScope);
  const cartItemsByProduct = useMemo(
    () => new Map(cart.data?.items.map((item) => [item.productId, item])),
    [cart.data?.items],
  );
  const productsById = useMemo(
    () => new Map(products.data?.map((product) => [product.id, product])),
    [products.data],
  );
  const mutationProductId = mutation.isPending ? mutation.variables?.productId : undefined;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Учебный магазин</p>
          <h1>Каталог и корзина</h1>
        </div>
        <a className={styles.cartLink} href="#cart">
          Корзина{' '}
          <span aria-label={`${cart.data?.quantity ?? 0} товаров`}>{cart.data?.quantity ?? 0}</span>
        </a>
      </header>

      {mutation.isError ? (
        <div className={styles.mutationError} role="alert">
          {errorMessage(mutation.error, 'Не удалось обновить корзину.')} Попробуйте ещё раз.
        </div>
      ) : null}

      <div className={styles.layout}>
        <section className={styles.catalog} aria-labelledby="catalog-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.sectionNumber}>01</p>
              <h2 id="catalog-title">Товары</h2>
            </div>
            <p>Цена и остаток приходят с сервера</p>
          </div>

          {products.isPending ? (
            <p className={styles.notice} aria-live="polite">
              Загружаем каталог…
            </p>
          ) : products.isError ? (
            <ErrorNotice
              message={errorMessage(products.error, 'Не удалось загрузить каталог.')}
              retry={() => void products.refetch()}
            />
          ) : products.data.length === 0 ? (
            <p className={styles.notice}>В каталоге пока нет товаров.</p>
          ) : (
            <ul className={styles.productGrid}>
              {products.data.map((product) => {
                const cartItem = cartItemsByProduct.get(product.id);
                const atStockLimit = (cartItem?.quantity ?? 0) >= product.stock;
                const isPending = mutationProductId === product.id;
                const unavailable = product.stock === 0;
                return (
                  <li className={styles.productCard} key={product.id}>
                    <div className={styles.productMeta}>
                      <span>{product.sku}</span>
                      <span className={unavailable ? styles.outOfStock : styles.inStock}>
                        {unavailable ? 'Нет в наличии' : `В наличии: ${product.stock}`}
                      </span>
                    </div>
                    <h3>{product.title}</h3>
                    <p className={styles.description}>{product.description}</p>
                    <div className={styles.productFooter}>
                      <strong>{formatMoney(product.price, product.currency)}</strong>
                      <button
                        className={styles.primaryButton}
                        type="button"
                        disabled={unavailable || atStockLimit || mutation.isPending}
                        aria-label={`Добавить «${product.title}» в корзину`}
                        onClick={() =>
                          mutation.mutate({
                            kind: 'set',
                            productId: product.id,
                            quantity: (cartItem?.quantity ?? 0) + 1,
                          })
                        }
                      >
                        {isPending
                          ? 'Добавляем…'
                          : unavailable
                            ? 'Нет в наличии'
                            : atStockLimit
                              ? 'Максимум'
                              : 'В корзину'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className={styles.cart} id="cart" aria-labelledby="cart-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.sectionNumber}>02</p>
              <h2 id="cart-title">Корзина</h2>
            </div>
            {cart.isFetching && !cart.isPending ? <span aria-live="polite">Обновляем…</span> : null}
          </div>

          {cart.isPending ? (
            <p className={styles.notice} aria-live="polite">
              Загружаем корзину…
            </p>
          ) : cart.isError && !cart.data ? (
            <ErrorNotice
              message={errorMessage(cart.error, 'Не удалось загрузить корзину.')}
              retry={() => void cart.refetch()}
            />
          ) : cart.data?.items.length === 0 ? (
            <div className={styles.emptyCart}>
              <p>Корзина пуста</p>
              <span>Добавьте доступный товар из каталога.</span>
            </div>
          ) : cart.data ? (
            <>
              {cart.isError ? (
                <ErrorNotice
                  message="Не удалось получить свежую корзину. Показаны последние данные."
                  retry={() => void cart.refetch()}
                />
              ) : null}
              <ul className={styles.cartList}>
                {cart.data.items.map((item) => {
                  const product = productsById.get(item.productId);
                  const isPending = mutationProductId === item.productId;
                  const canIncrease = product ? item.quantity < product.stock : false;
                  return (
                    <li className={styles.cartItem} key={item.productId}>
                      <div className={styles.cartItemTitle}>
                        <h3>{item.title}</h3>
                        <span>{formatMoney(item.unitPrice, cart.data.currency)} за шт.</span>
                      </div>
                      <div className={styles.cartControls}>
                        <div className={styles.quantity} aria-label={`Количество «${item.title}»`}>
                          <button
                            type="button"
                            disabled={item.quantity <= 1 || mutation.isPending}
                            aria-label={`Уменьшить количество «${item.title}»`}
                            onClick={() =>
                              mutation.mutate({
                                kind: 'set',
                                productId: item.productId,
                                quantity: item.quantity - 1,
                              })
                            }
                          >
                            −
                          </button>
                          <output aria-live="polite">{item.quantity}</output>
                          <button
                            type="button"
                            disabled={!canIncrease || mutation.isPending}
                            aria-label={`Увеличить количество «${item.title}»`}
                            onClick={() =>
                              mutation.mutate({
                                kind: 'set',
                                productId: item.productId,
                                quantity: item.quantity + 1,
                              })
                            }
                          >
                            +
                          </button>
                        </div>
                        <strong>{formatMoney(item.lineTotal, cart.data.currency)}</strong>
                      </div>
                      <button
                        className={styles.removeButton}
                        type="button"
                        disabled={mutation.isPending}
                        aria-label={`Удалить «${item.title}» из корзины`}
                        onClick={() =>
                          mutation.mutate({ kind: 'remove', productId: item.productId })
                        }
                      >
                        {isPending && mutation.variables?.kind === 'remove'
                          ? 'Удаляем…'
                          : 'Удалить'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className={styles.total}>
                <span>Итого · {cart.data.quantity} шт.</span>
                <strong>{formatMoney(cart.data.subtotal, cart.data.currency)}</strong>
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
