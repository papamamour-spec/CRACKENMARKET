import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMarket } from "../hooks/useMarket";
import { compact, fmtNum, fmtPct, signClass } from "../lib/format";
import type { Quote } from "../lib/types";

type Key = "symbol" | "price" | "changePct" | "volume" | "value" | "sector";

export function QuoteTable({ rows, compactMode = false }: { rows: Quote[]; compactMode?: boolean }) {
  const { lastUpdated } = useMarket();
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "value", dir: -1 });
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const va = a[sort.key];
        const vb = b[sort.key];
        if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * sort.dir;
        return ((va as number) - (vb as number)) * sort.dir;
      }),
    [rows, sort],
  );
  const th = (key: Key, label: string, cls = "") => (
    <th className={cls} onClick={() => setSort({ key, dir: sort.key === key ? ((sort.dir * -1) as 1 | -1) : -1 })}>
      {label} {sort.key === key ? (sort.dir > 0 ? "▲" : "▼") : ""}
    </th>
  );
  return (
    <table>
      <thead>
        <tr>
          {th("symbol", "Valeur", "left")}
          {!compactMode && th("sector", "Secteur", "left")}
          {th("price", "Cours")}
          {th("changePct", "Var. %")}
          {!compactMode && <th>Ouv. / Haut / Bas</th>}
          {th("volume", "Volume")}
          {th("value", "Capitaux")}
        </tr>
      </thead>
      <tbody>
        {sorted.map((q) => (
          <tr key={q.symbol} className={lastUpdated.has(q.symbol) ? (q.change >= 0 ? "flash-up" : "flash-down") : ""}>
            <td>
              <Link to={`/valeur/${q.symbol}`} className="sym">
                {q.symbol}
                <small>{q.name}</small>
              </Link>
            </td>
            {!compactMode && <td className="left muted">{q.sector}</td>}
            <td className="mono" style={{ fontWeight: 600 }}>{fmtNum(q.price)}</td>
            <td className={`mono ${signClass(q.changePct)}`}>{fmtPct(q.changePct)}</td>
            {!compactMode && <td className="mono muted">{fmtNum(q.open)} / {fmtNum(q.high)} / {fmtNum(q.low)}</td>}
            <td className="mono">{fmtNum(q.volume)}</td>
            <td className="mono">{compact(q.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
