import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMarket } from "../hooks/useMarket";
import { compact, fmtNum, fmtPct, signClass } from "../lib/format";
import { PERIODS, PERIOD_LABEL, type Period, type Quote } from "../lib/types";

type Key = "symbol" | "price" | "perf" | "volume" | "value" | "sector";

interface Props {
  rows: Quote[];
  compactMode?: boolean;
  /** Période affichée dans la colonne de variation (sélecteur intégré si `showPeriodPicker`) */
  period?: Period;
  showPeriodPicker?: boolean;
}

/** Cote avec variation multi-périodes (veille par défaut), tri par colonne, flash en temps réel. */
export function QuoteTable({ rows, compactMode = false, period: initial = "1D", showPeriodPicker = false }: Props) {
  const { lastUpdated } = useMarket();
  const [period, setPeriod] = useState<Period>(initial);
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "value", dir: -1 });
  const perfOf = (q: Quote) => q.perf?.[period] ?? (period === "1D" ? q.changePct : null);
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (sort.key === "perf") return ((perfOf(a) ?? -Infinity) - (perfOf(b) ?? -Infinity)) * sort.dir;
        const va = a[sort.key];
        const vb = b[sort.key];
        if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * sort.dir;
        return ((va as number) - (vb as number)) * sort.dir;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sort, period],
  );
  const th = (key: Key, label: string, cls = "") => (
    <th className={cls} onClick={() => setSort({ key, dir: sort.key === key ? ((sort.dir * -1) as 1 | -1) : -1 })}>
      {label} {sort.key === key ? (sort.dir > 0 ? "▲" : "▼") : ""}
    </th>
  );
  return (
    <div>
      {showPeriodPicker && (
        <div className="seg" style={{ marginBottom: 8 }}>
          {PERIODS.map((p) => <button key={p} className={p === period ? "active" : ""} onClick={() => setPeriod(p)}>{PERIOD_LABEL[p]}</button>)}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {th("symbol", "Valeur", "left")}
              {!compactMode && th("sector", "Secteur", "left")}
              {th("price", "Cours")}
              {th("perf", period === "1D" ? "Var. veille" : `Var. ${PERIOD_LABEL[period]}`)}
              {!compactMode && <th>Ouv. / Haut / Bas</th>}
              {th("volume", "Volume")}
              {th("value", "Capitaux")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((q) => {
              const v = perfOf(q);
              return (
                <tr key={q.symbol} className={lastUpdated.has(q.symbol) ? (q.change >= 0 ? "flash-up" : "flash-down") : ""}>
                  <td>
                    <Link to={`/valeur/${q.symbol}`} className="sym">
                      {q.symbol}
                      <small>{q.name}</small>
                    </Link>
                  </td>
                  {!compactMode && <td className="left muted">{q.sector}</td>}
                  <td className="mono" style={{ fontWeight: 600 }}>{fmtNum(q.price)}</td>
                  <td className={`mono ${v === null ? "muted" : signClass(v)}`}>{v === null ? "—" : fmtPct(v)}</td>
                  {!compactMode && <td className="mono muted">{fmtNum(q.open)} / {fmtNum(q.high)} / {fmtNum(q.low)}</td>}
                  <td className="mono">{fmtNum(q.volume)}</td>
                  <td className="mono">{compact(q.value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
