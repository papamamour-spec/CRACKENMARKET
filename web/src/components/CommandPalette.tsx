import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMarket } from "../hooks/useMarket";
import { fmtNum, fmtPct, signClass } from "../lib/format";

const PAGES: { label: string; to: string; hint: string }[] = [
  { label: "Accueil", to: "/", hint: "Vos conseils du jour" },
  { label: "Mes conseils", to: "/conseiller", hint: "Recommandations et diagnostic" },
  { label: "Demander un conseil", to: "/conseil", hint: "Nouvelle demande de placement" },
  { label: "Portefeuille", to: "/portefeuille", hint: "Positions et ordres" },
  { label: "Performance", to: "/performance", hint: "Courbe et statistiques" },
  { label: "Signaux & agenda", to: "/actualites", hint: "Actualité, signaux, événements" },
  { label: "Marché", to: "/marche", hint: "Cote complète et screener" },
  { label: "Classement", to: "/classement", hint: "Investisseurs" },
  { label: "Suivi & alertes", to: "/alertes", hint: "Liste de suivi" },
  { label: "Ma SGI", to: "/sgi", hint: "Compte-titres et ordres réels" },
  { label: "Backtest", to: "/backtest", hint: "Tester une stratégie" },
  { label: "Mon profil", to: "/profil", hint: "Questionnaire investisseur" },
  { label: "Compte", to: "/compte", hint: "Sécurité, parrainage, API" },
];

/** Recherche globale (Ctrl/⌘ + K) : valeurs et pages, navigation au clavier. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { quotes } = useMarket();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const syms = Array.from(quotes.values())
      .filter((x) => !needle || x.symbol.toLowerCase().includes(needle) || x.name.toLowerCase().includes(needle) || x.sector.toLowerCase().includes(needle))
      .sort((a, b) => (a.symbol.toLowerCase().startsWith(needle) ? -1 : 1) - (b.symbol.toLowerCase().startsWith(needle) ? -1 : 1) || b.value - a.value)
      .slice(0, 8)
      .map((x) => ({ kind: "symbol" as const, label: x.symbol, hint: x.name, to: `/valeur/${x.symbol}`, quote: x }));
    const pages = PAGES.filter((p) => !needle || p.label.toLowerCase().includes(needle) || p.hint.toLowerCase().includes(needle)).slice(0, 6).map((p) => ({ kind: "page" as const, ...p, quote: undefined }));
    return needle ? [...syms, ...pages] : [...pages.slice(0, 5), ...syms.slice(0, 5)];
  }, [q, quotes]);
  useEffect(() => setIdx(0), [results.length]);
  if (!open) return null;
  const go = (i: number) => {
    const r = results[i];
    if (!r) return;
    nav(r.to);
    onClose();
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Recherche" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher une valeur, une page… (Échap pour fermer)"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            if (e.key === "Enter") go(idx);
            if (e.key === "Escape") onClose();
          }}
        />
        <ul>
          {results.map((r, i) => (
            <li key={`${r.kind}-${r.label}`} className={i === idx ? "active" : ""} onMouseEnter={() => setIdx(i)} onClick={() => go(i)}>
              <span className={`palette-kind ${r.kind}`}>{r.kind === "symbol" ? "Valeur" : "Page"}</span>
              <span className="palette-label">{r.label}</span>
              <span className="palette-hint">{r.hint}</span>
              {r.quote && <span className={`mono ${signClass(r.quote.changePct)}`}>{fmtNum(r.quote.price)} · {fmtPct(r.quote.changePct)}</span>}
            </li>
          ))}
          {results.length === 0 && <li className="muted">Aucun résultat</li>}
        </ul>
        <div className="palette-foot muted">↑↓ naviguer · Entrée ouvrir · Échap fermer</div>
      </div>
    </div>
  );
}
