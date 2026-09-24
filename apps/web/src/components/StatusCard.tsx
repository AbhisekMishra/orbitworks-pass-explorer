import { RetryIcon } from './icons';
import styles from './StatusCard.module.css';

interface LoadingProps {
  title: string;
  detail?: string;
}

/** Centered progress card over the map (the basemap stays visible and interactive behind it). */
export function LoadingCard({ title, detail }: Readonly<LoadingProps>) {
  return (
    <div className={styles.card} role="status" aria-live="polite" data-testid="loading">
      <span className={styles.spinner} aria-hidden="true" />
      <div>
        <p className={styles.title}>{title}</p>
        {detail && <p className={styles.detail}>{detail}</p>}
      </div>
    </div>
  );
}

interface ErrorProps {
  title: string;
  message: string;
  onRetry: () => void;
}

export function ErrorCard({ title, message, onRetry }: Readonly<ErrorProps>) {
  return (
    <div className={styles.card} data-variant="error" role="alert" data-testid="error">
      <div>
        <p className={styles.title}>{title}</p>
        <p className={styles.detail}>{message}</p>
      </div>
      <button type="button" className={styles.retry} onClick={onRetry}>
        <RetryIcon size={14} />
        Retry
      </button>
    </div>
  );
}
