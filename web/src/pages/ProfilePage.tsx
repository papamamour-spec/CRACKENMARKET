import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, put } from "../lib/api";
import type { DeclaredProfile } from "../lib/types";

const QUESTIONS = [
  { key: "riskTolerance", q: "Si votre portefeuille perdait 20 % en trois mois, que feriez-vous ?", opts: [[1, "Je vends tout"], [2, "Je vends une partie"], [3, "J'attends"], [4, "Je renforce un peu"], [5, "Je renforce fortement"]] },
] as const;

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const [p, setP] = useState<DeclaredProfile>({ riskTolerance: 3, horizonMonths: 24, objective: "growth", experience: "beginner", monthlyCapacity: 0, preferredSectors: [] });
  const [sectors, setSectors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<DeclaredProfile>("/profile").then(setP).catch(() => {});
    api<{ sectors: string[] }>("/market/sectors").then((r) => setSectors(r.sectors)).catch(() => {});
  }, []);

  const save = async () => {
    await put("/profile", p);
    await refresh();
    setSaved(true);
    setTimeout(() => nav("/conseiller"), 800);
  };
  const toggleSector = (s: string) => setP({ ...p, preferredSectors: p.preferredSectors.includes(s) ? p.preferredSectors.filter((x) => x !== s) : [...p.preferredSectors, s].slice(0, 5) });

  return (
    <div className="two-col">
      <div className="card">
        <h1>Mon profil investisseur</h1>
        <p className="muted">Ces réponses calibrent le moteur de conseil. Votre comportement réel (ordres, réactions aux baisses) ajuste ensuite automatiquement ce profil.</p>
        <div className="field">
          <label>{QUESTIONS[0].q}</label>
          <div className="seg" style={{ flexWrap: "wrap" }}>
            {QUESTIONS[0].opts.map(([v, l]) => <button key={v} className={p.riskTolerance === v ? "active" : ""} onClick={() => setP({ ...p, riskTolerance: v })}>{l}</button>)}
          </div>
        </div>
        <div className="field">
          <label>Horizon de placement : {p.horizonMonths} mois</label>
          <div className="range"><span className="muted">3</span><input type="range" min={3} max={120} step={3} value={p.horizonMonths} onChange={(e) => setP({ ...p, horizonMonths: Number(e.target.value) })} /><span className="muted">120</span></div>
        </div>
        <div className="field">
          <label>Objectif principal</label>
          <select value={p.objective} onChange={(e) => setP({ ...p, objective: e.target.value as DeclaredProfile["objective"] })}>
            <option value="income">Revenus réguliers (dividendes)</option>
            <option value="balanced">Équilibre revenus / croissance</option>
            <option value="growth">Croissance du capital</option>
            <option value="speculative">Plus-values rapides (spéculatif)</option>
          </select>
        </div>
        <div className="field">
          <label>Expérience des marchés</label>
          <select value={p.experience} onChange={(e) => setP({ ...p, experience: e.target.value as DeclaredProfile["experience"] })}>
            <option value="beginner">Débutant (moins d'un an)</option>
            <option value="intermediate">Intermédiaire (1 à 5 ans)</option>
            <option value="expert">Confirmé (plus de 5 ans)</option>
          </select>
        </div>
        <div className="field"><label>Capacité d'épargne mensuelle (FCFA)</label><input type="number" value={p.monthlyCapacity} onChange={(e) => setP({ ...p, monthlyCapacity: Number(e.target.value) })} /></div>
        <div className="field">
          <label>Secteurs privilégiés (5 max.)</label>
          {sectors.map((s) => <span key={s} className={`chip ${p.preferredSectors.includes(s) ? "sel" : ""}`} onClick={() => toggleSector(s)} style={{ cursor: "pointer" }}>{s}</span>)}
        </div>
        <button className="btn primary" onClick={save}>Enregistrer et voir mes conseils</button>
        {saved && <div className="success">Profil enregistré.</div>}
      </div>
      <div className="card">
        <h3>Compte</h3>
        <p><b>{user?.fullName}</b><br /><span className="muted">{user?.email}</span></p>
        <p className="muted">Rôle : {{ investor: "Investisseur particulier", sgi: "SGI", institutional: "Institutionnel", analyst: "Analyste", admin: "Administrateur" }[user?.role ?? "investor"]}</p>
        <h3 style={{ marginTop: 16 }}>Comment fonctionne le conseiller ?</h3>
        <ul className="clean">
          <li><b>Historique de marché</b> : tendance (MM20/50/200), momentum (RSI, MACD, performance 1 mois), retour à la moyenne (Bollinger), volumes (OBV) et risque (volatilité, drawdown) sur 2 ans de données.</li>
          <li><b>Comportement</b> : fréquence d'ordres, durée de détention, réactions aux hausses et baisses, concentration, suivi des conseils. Les biais détectés (sur-activité, effet de disposition, achats après hausse, ventes paniques…) ajustent votre tolérance effective.</li>
          <li><b>Personnalisation</b> : les pondérations du score varient selon votre style ; l'adéquation profil/valeur filtre les idées ; objectif, stop et taille de position sont calculés à partir de l'ATR et de votre budget de risque.</li>
          <li><b>Temps réel</b> : chaque cotation met à jour les cours, les positions, les alertes et les scores.</li>
        </ul>
      </div>
    </div>
  );
}
