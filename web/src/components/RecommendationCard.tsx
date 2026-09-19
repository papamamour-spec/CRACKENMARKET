import { Link } from "react-router-dom";
import { post } from "../lib/api";
import { fmtFcfa, fmtNum, fmtPct } from "../lib/format";
import type { Recommendation } from "../lib/types";
import { ActionBadge, ScoreBar } from "./ScoreBar";

export function RecommendationCard({ rec, detailed = false }: { rec: Recommendation; detailed?: boolean }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <Link to={`/valeur/${rec.symbol}`} className="sym">
            {rec.symbol} <small>{rec.name} · {rec.sector}</small>
          </Link>
        </div>
        <ActionBadge action={rec.action} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div className="gauge"><span className="muted" style={{ width: 70, fontSize: 12 }}>Score</span><ScoreBar value={rec.score} /><span className="mono" style={{ width: 36, textAlign: "right" }}>{rec.score}</span></div>
        <div className="gauge"><span className="muted" style={{ width: 70, fontSize: 12 }}>Adéquation</span><ScoreBar value={rec.fitScore} positive /><span className="mono" style={{ width: 36, textAlign: "right" }}>{rec.fitScore}</span></div>
      </div>
      <div className="row" style={{ marginTop: 10, fontSize: 13 }}>
        <span>Cours <b className="mono">{fmtNum(rec.price)}</b></span>
        <span>Objectif <b className="mono up">{fmtNum(rec.targetPrice)}</b></span>
        <span>Stop <b className="mono down">{fmtNum(rec.stopLoss)}</b></span>
        <span>Potentiel <b className={rec.expectedReturnPct >= 0 ? "up" : "down"}>{fmtPct(rec.expectedReturnPct, 1)}</b></span>
        <span>R/R <b className="mono">{rec.riskRewardRatio}</b></span>
        <span>Confiance <b className="mono">{Math.round(rec.confidence * 100)} %</b></span>
      </div>
      {rec.suggestedQuantity > 0 && (
        <p style={{ margin: "8px 0", fontSize: 13 }}>
          Taille suggérée : <b>{rec.suggestedQuantity} titres</b> (≈ {fmtFcfa(rec.suggestedAmount)}) · horizon {rec.horizon}
        </p>
      )}
      {(detailed || rec.rationale.length) && (
        <ul className="clean">
          {rec.rationale.slice(0, detailed ? 10 : 3).map((r, i) => (
            <li key={i}>✔ {r}</li>
          ))}
          {rec.warnings.map((w, i) => (
            <li key={`w${i}`} style={{ color: "var(--warn)" }}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {detailed && (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>Ce conseil vous a-t-il été utile ?</span>
          <button className="btn sm" onClick={() => post("/advisor/feedback", { symbol: rec.symbol, followed: true })}>Je le suis</button>
          <button className="btn sm" onClick={() => post("/advisor/feedback", { symbol: rec.symbol, followed: false })}>Je l'ignore</button>
        </div>
      )}
    </div>
  );
}
