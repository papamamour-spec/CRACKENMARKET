/** Placeholders de chargement (états intermédiaires cohérents). */
export function Skeleton({ lines = 3, height = 14 }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }, (_, i) => <span key={i} style={{ height, width: `${90 - (i % 3) * 18}%` }} />)}
    </div>
  );
}

export function SkeletonCard({ title, lines = 3 }: { title?: string; lines?: number }) {
  return (
    <div className="card">
      {title && <h3>{title}</h3>}
      <Skeleton lines={lines} />
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">◎</div>
      <b>{title}</b>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}
