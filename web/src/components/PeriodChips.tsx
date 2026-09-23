import { fmtPct, signClass } from "../lib/format";
import { PERIODS, PERIOD_LABEL, type Quote } from "../lib/types";

/** Variations par période, recalculées à chaque cotation. */
export function PeriodChips({ quote }: { quote: Quote }) {
  return (
    <div className="period-chips">
      {PERIODS.map((p) => {
        const v = quote.perf?.[p];
        return (
          <div key={p} className={`period-chip ${v === null || v === undefined ? "" : signClass(v)}`} title={p === "1D" ? "Par rapport à la clôture de la veille" : "Par rapport à la clôture de la séance de référence"}>
            <span className="period-label">{PERIOD_LABEL[p]}</span>
            <span className="period-value mono">{v === null || v === undefined ? "—" : fmtPct(v, 1)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Position du cours dans la fourchette 52 semaines. */
export function Range52({ quote }: { quote: Quote }) {
  const span = quote.high52 - quote.low52;
  const pos = span > 0 ? Math.max(0, Math.min(100, ((quote.price - quote.low52) / span) * 100)) : 50;
  return (
    <div className="range52" title="Fourchette 52 semaines">
      <span className="mono muted">{quote.low52.toLocaleString("fr-FR")}</span>
      <div className="range52-bar"><i style={{ left: `${pos}%` }} /></div>
      <span className="mono muted">{quote.high52.toLocaleString("fr-FR")}</span>
    </div>
  );
}
