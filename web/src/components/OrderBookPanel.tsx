import { useOrderBook } from "../hooks/useMarket";
import { fmtNum, fmtTime } from "../lib/format";

/** Carnet d'ordres à 5 niveaux avec barres de profondeur cumulée et indicateur de déséquilibre. */
export function OrderBookPanel({ symbol }: { symbol: string }) {
  const book = useOrderBook(symbol);
  if (!book) return <div className="card"><h3>Carnet d'ordres</h3><p className="muted">En attente du flux…</p></div>;
  const cum = (levels: { quantity: number }[]) => {
    let acc = 0;
    return levels.map((l) => (acc += l.quantity));
  };
  const bidCum = cum(book.bids);
  const askCum = cum(book.asks);
  const maxCum = Math.max(bidCum[bidCum.length - 1] ?? 1, askCum[askCum.length - 1] ?? 1);
  const bidPct = Math.round(((book.imbalance + 1) / 2) * 100);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Carnet d'ordres</h3>
        <span className="muted" style={{ fontSize: 11 }}>
          Fourchette {fmtNum(book.spread)} ({book.spreadPct} %) · {fmtTime(book.ts)}
        </span>
      </div>
      <div className="imbalance" title="Pression acheteuse / vendeuse sur les 5 premiers niveaux">
        <i className="bid" style={{ width: `${bidPct}%` }} />
        <i className="ask" style={{ width: `${100 - bidPct}%` }} />
        <span className="up">{bidPct} %</span>
        <span className="down">{100 - bidPct} %</span>
      </div>
      <div className="book">
        <div className="book-side">
          <div className="book-row head"><span>Ordres</span><span>Quantité</span><span>Achat</span></div>
          {book.bids.map((l, i) => (
            <div key={l.price} className="book-row bid">
              <i style={{ width: `${(bidCum[i] / maxCum) * 100}%` }} />
              <span className="muted">{l.orders}</span>
              <span className="mono">{fmtNum(l.quantity)}</span>
              <span className="mono up">{fmtNum(l.price)}</span>
            </div>
          ))}
        </div>
        <div className="book-side">
          <div className="book-row head"><span>Vente</span><span>Quantité</span><span>Ordres</span></div>
          {book.asks.map((l, i) => (
            <div key={l.price} className="book-row ask">
              <i style={{ width: `${(askCum[i] / maxCum) * 100}%` }} />
              <span className="mono down">{fmtNum(l.price)}</span>
              <span className="mono">{fmtNum(l.quantity)}</span>
              <span className="muted">{l.orders}</span>
            </div>
          ))}
        </div>
      </div>
      {book.estimated && <p className="disclaimer" style={{ marginTop: 6 }}>Profondeur reconstituée à partir du dernier cours et de la liquidité de la valeur (la BRVM ne diffuse pas son carnet en accès public).</p>}
    </div>
  );
}
