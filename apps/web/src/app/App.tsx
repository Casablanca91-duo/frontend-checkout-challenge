import { useSession } from '../checkout/session/SessionProvider';
import { Outlet } from 'react-router-dom';
import styles from './App.module.css';

export function App() {
  const session = useSession();

  if (session.status === 'loading') {
    return (
      <main className={styles.page} aria-busy="true">
        <section className={styles.panel} aria-live="polite">
          <p className={styles.eyebrow}>Оформление заказа</p>
          <h1>Подготавливаем сессию…</h1>
          <p className={styles.description}>Проверяем сохранённые данные и серверную корзину.</p>
        </section>
      </main>
    );
  }

  if (session.status === 'error') {
    return (
      <main className={styles.page}>
        <section className={styles.panel} role="alert">
          <p className={styles.eyebrow}>Соединение прервано</p>
          <h1>Не удалось подготовить checkout</h1>
          <p className={styles.description}>
            Проверьте соединение и повторите попытку. Если сессия уже была сохранена, она не
            удалена.
          </p>
          <button className={styles.button} type="button" onClick={session.retry}>
            Повторить
          </button>
        </section>
      </main>
    );
  }

  return <Outlet context={{ sessionScope: session.sessionScope }} />;
}
