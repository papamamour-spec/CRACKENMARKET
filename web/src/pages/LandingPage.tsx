import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeToggle";
import { useMarket } from "../hooks/useMarket";
import { api } from "../lib/api";
import { compact, fmtNum, fmtPct, signClass } from "../lib/format";
import type { LeaderboardEntry, Signal } from "../lib/types";

const FEATURES = [
  ["Conseil de placement chiffré", "Décrivez votre capital, votre objectif et votre horizon : vous recevez une allocation motivée valeur par valeur, avec rendement attendu, scénarios et réserve de liquidités."],
  ["Relecture par un analyste", "Chaque proposition du moteur Kraken est relue, annotée et validée par un analyste avant d'être présentée comme conseil."],
  ["Un guichet pour les SGI", "Les sociétés de gestion sollicitent la plateforme pour les placements de leurs clients et présentent un rapport prêt à signer."],
  ["Conseiller qui vous connaît", "Le moteur croise cinq ans d'historique, 15 indicateurs et votre comportement réel pour adapter chaque recommandation à votre profil."],
  ["Suivi du portefeuille", "Santé, diversification, risque, rééquilibrage suggéré et performance face au BRVM Composite, recalculés à chaque cotation."],
  ["Signaux et agenda", "Croisements, surventes, cassures publiés en direct ; dividendes, assemblées et résultats des 46 sociétés cotées."],
  ["Exécution par votre SGI", "Ouvrez votre compte-titres chez Matha Capital depuis la plateforme et faites exécuter les conseils, avec suivi en temps réel."],
  ["Sécurité de niveau bancaire", "Double authentification, clés API pour les SGI et institutionnels, application installable sur mobile."],
];

/** Page d'accueil publique : cote en direct sans compte, arguments d'inscription. */
export function LandingPage() {
  const { quotes, indices, status } = useMarket();
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  useEffect(() => {
    api<LeaderboardEntry[]>("/social/leaderboard?period=month").then((l) => setLeaders(l.slice(0, 5))).catch(() => {});
    api<Signal[]>("/market/signals?limit=6").then(setSignals).catch(() => {});
  }, []);
  const all = Array.from(quotes.values());
  const gainers = [...all].sort((a, b) => b.changePct - a.changePct).slice(0, 6);
  const totalValue = all.reduce((a, q) => a + q.value, 0);

  return (
    <div>
      <div className="public-topbar">
        <div className="brand">Cracken<span>Market</span></div>
        <span className="status-pill"><span className={`dot ${status?.provider === "live" ? "on" : "sim"}`} />{status?.provider === "live" ? "Temps réel BRVM" : "Simulation temps réel"}</span>
        <span className="spacer" />
        <ThemeToggle />
        <Link to="/connexion" className="btn">Connexion</Link>
        <Link to="/connexion?inscription=1" className="btn primary">Ouvrir un compte gratuit</Link>
      </div>
      <div className="ticker">
        <div className="ticker-track">
          {all.map((q) => (
            <span key={q.symbol} className="ticker-item"><b>{q.symbol}</b><span className="mono">{fmtNum(q.price)}</span><span className={signClass(q.changePct)}>{fmtPct(q.changePct)}</span></span>
          ))}
        </div>
      </div>
      <div className="landing">
        <section className="hero">
          <div>
            <h1>Le conseil en investissement de la <span>BRVM</span>.</h1>
            <p>Dites-nous combien placer, pour quel objectif et sur quel horizon : CrackenMarket vous propose une allocation motivée et chiffrée, relue par un analyste, puis exécutée par votre SGI. Particuliers, institutionnels et SGI y trouvent le même guichet.</p>
            <div className="cta">
              <Link to="/connexion?inscription=1" className="btn primary">Demander un conseil de placement</Link>
              <Link to="/connexion?inscription=1" className="btn">Je suis une SGI</Link>
            </div>
            <div className="stat-row">
              {indices.map((i) => <div key={i.name} className="kpi"><span className="label">{i.name}</span><span className="value">{fmtNum(i.value, 2)}</span><span className={`sub ${signClass(i.changePct)}`}>{fmtPct(i.changePct)}</span></div>)}
              <div className="kpi"><span className="label">Capitaux du jour</span><span className="value">{compact(totalValue)} F</span><span className="sub muted">{all.length} valeurs</span></div>
            </div>
          </div>
          <div className="card">
            <h3>Plus fortes hausses du jour</h3>
            <table><tbody>{gainers.map((q) => <tr key={q.symbol}><td className="left sym">{q.symbol}<small>{q.name}</small></td><td className="mono">{fmtNum(q.price)}</td><td className={`mono ${signClass(q.changePct)}`}>{fmtPct(q.changePct)}</td></tr>)}</tbody></table>
            {signals.length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>Derniers signaux Kraken</h3>
                {signals.map((s) => <div key={s.id} className="signal"><span className={`dot ${s.kind}`} /><span><b>{s.symbol}</b> {s.message}</span></div>)}
              </>
            )}
          </div>
        </section>
        <section className="features">
          {FEATURES.map(([t, d]) => <div key={t} className="feature"><b>{t}</b><p>{d}</p></div>)}
        </section>
        {leaders.length > 0 && (
          <section className="card" style={{ marginTop: 24 }}>
            <div className="card-head"><h2>Meilleurs investisseurs du mois</h2><Link to="/classement">Classement complet →</Link></div>
            <table>
              <thead><tr><th className="left">#</th><th className="left">Investisseur</th><th>Perf. 30 j</th><th>Perf. totale</th><th>Abonnés</th></tr></thead>
              <tbody>{leaders.map((l, i) => <tr key={l.userId}><td><span className={`rank r${i + 1}`}>{i + 1}</span></td><td className="left">{l.displayName}</td><td className={`mono ${signClass(l.monthReturnPct)}`}>{fmtPct(l.monthReturnPct)}</td><td className={`mono ${signClass(l.totalReturnPct)}`}>{fmtPct(l.totalReturnPct)}</td><td className="mono">{l.followers}</td></tr>)}</tbody>
            </table>
          </section>
        )}
        <p className="disclaimer" style={{ marginTop: 24 }}>CrackenMarket est un outil d'aide à la décision et d'entraînement. Les portefeuilles sont virtuels ; les ordres réels se passent auprès d'une SGI agréée par l'AMF-UMOA. Les performances passées ne préjugent pas des performances futures.</p>
      </div>
    </div>
  );
}
