/** Barre de score centrée : valeur de -100 à 100 (ou 0..100 en mode `positive`). */
export function ScoreBar({ value, positive = false, color }: { value: number; positive?: boolean; color?: string }) {
  if (positive) {
    const pct = Math.max(0, Math.min(100, value));
    const c = color ?? (pct >= 66 ? "var(--up)" : pct >= 40 ? "var(--warn)" : "var(--down)");
    return (
      <div className="scorebar">
        <i style={{ left: 0, width: `${pct}%`, background: c }} />
      </div>
    );
  }
  const v = Math.max(-100, Math.min(100, value));
  const w = Math.abs(v) / 2;
  return (
    <div className="scorebar center">
      <i className={v < 0 ? "neg" : ""} style={{ width: `${w}%`, background: color ?? (v >= 0 ? "var(--up)" : "var(--down)") }} />
    </div>
  );
}

export function ActionBadge({ action }: { action: string }) {
  const cls =
    action === "ACHAT FORT" ? "strong-buy" : action === "ACHAT" ? "buy" : action === "CONSERVER" ? "hold" : action === "ALLÉGER" ? "reduce" : action === "VENTE" ? "sell" : "avoid";
  return <span className={`badge ${cls}`}>{action}</span>;
}
