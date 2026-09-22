import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useAuth } from "../hooks/useAuth";
import { api, del, post, put } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import type { ApiKey, Referrals, User } from "../lib/types";

export function AccountPage() {
  const { user, refresh } = useAuth();
  const [tab, setTab] = useState<"securite" | "parrainage" | "api">("securite");
  return (
    <div className="grid">
      <div className="card row">
        <div><h1>Mon compte</h1><span className="muted">{user?.fullName} · {user?.email} · {user?.points ?? 0} points</span></div>
      </div>
      <div className="tabs">
        <button className={tab === "securite" ? "active" : ""} onClick={() => setTab("securite")}>Sécurité</button>
        <button className={tab === "parrainage" ? "active" : ""} onClick={() => setTab("parrainage")}>Parrainage & points</button>
        <button className={tab === "api" ? "active" : ""} onClick={() => setTab("api")}>Clés API</button>
      </div>
      {tab === "securite" && <SecurityTab user={user} refresh={refresh} />}
      {tab === "parrainage" && <ReferralTab />}
      {tab === "api" && <ApiTab />}
    </div>
  );
}

function SecurityTab({ user, refresh }: { user: User | null; refresh: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const start = async () => {
    const r = await post<{ secret: string; otpauth: string }>("/auth/2fa/setup", {});
    const qr = await QRCode.toDataURL(r.otpauth, { margin: 1, width: 180 });
    setSetup({ ...r, qr });
    setMsg(null);
  };
  const enable = async () => {
    try {
      await post("/auth/2fa/enable", { code });
      setSetup(null);
      setCode("");
      setMsg({ ok: true, text: "Double authentification activée. +150 points." });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const disable = async () => {
    try {
      await post("/auth/2fa/disable", { code });
      setCode("");
      setMsg({ ok: true, text: "Double authentification désactivée." });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const togglePublic = async () => {
    await put("/account/public", { publicProfile: !user?.publicProfile });
    await refresh();
  };
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Double authentification (2FA)</h2>
        <p className="muted">Un code à 6 chiffres généré par Google Authenticator, Authy ou toute application compatible est demandé à chaque connexion.</p>
        {user?.totpEnabled ? (
          <>
            <p className="success">Active sur votre compte.</p>
            <div className="field"><label>Code actuel pour désactiver</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" /></div>
            <button className="btn" onClick={disable}>Désactiver</button>
          </>
        ) : setup ? (
          <>
            <p>1. Scannez ce QR code dans votre application d'authentification :</p>
            <div className="qr"><img src={setup.qr} alt="QR code 2FA" width={180} height={180} /></div>
            <p className="muted" style={{ fontSize: 12 }}>Ou saisissez la clé manuellement : <code>{setup.secret}</code></p>
            <div className="field"><label>2. Entrez le code affiché</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" /></div>
            <button className="btn primary" onClick={enable}>Activer</button>
          </>
        ) : (
          <button className="btn primary" onClick={start}>Activer la double authentification</button>
        )}
        {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      </div>
      <div className="card">
        <h2>Visibilité</h2>
        <p className="muted">Un profil public apparaît dans le classement et peut être suivi par les autres membres. Vos montants en FCFA ne sont jamais affichés, seulement les pourcentages et la répartition.</p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={!!user?.publicProfile} onChange={togglePublic} style={{ width: "auto" }} />
          Profil public (classement, suivi)
        </label>
      </div>
    </div>
  );
}

function ReferralTab() {
  const [data, setData] = useState<Referrals | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<Referrals>("/account/referrals").then(setData).catch(() => {});
  }, []);
  if (!data) return <div className="card">Chargement…</div>;
  const link = `${location.origin}/connexion?inscription=1&parrain=${data.user.referralCode}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* presse-papiers indisponible */
    }
  };
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Parrainez, gagnez des points</h2>
        <p className="muted">Chaque investisseur inscrit avec votre code vous rapporte <b>{data.rewards.referrer} points</b> et lui en offre <b>{data.rewards.referred}</b>. Les points comptent au classement et donneront accès aux fonctionnalités premium.</p>
        <div className="field"><label>Votre code</label><input readOnly value={data.user.referralCode ?? ""} /></div>
        <div className="field"><label>Lien d'invitation</label><input readOnly value={link} /></div>
        <button className="btn primary" onClick={copy}>{copied ? "Copié !" : "Copier le lien"}</button>
        <h3 style={{ marginTop: 16 }}>Filleuls ({data.referred.length})</h3>
        <ul className="clean">{data.referred.map((r, i) => <li key={i}>{r.fullName} <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(r.createdAt)}</span></li>)}</ul>
      </div>
      <div className="card">
        <h2>Historique des points · total {data.user.points}</h2>
        <table><tbody>{data.ledger.map((l, i) => <tr key={i}><td className="left mono muted">{fmtDateTime(l.ts)}</td><td className="left">{l.reason}</td><td className="mono up">+{l.points}</td></tr>)}</tbody></table>
        <h3 style={{ marginTop: 16 }}>Comment gagner des points</h3>
        <ul className="clean">
          <li>Création du compte : +{data.rewards.signup}</li>
          <li>Premier ordre exécuté : +{data.rewards.firstOrder}</li>
          <li>Activation de la double authentification : +{data.rewards.twoFactor}</li>
          <li>Chaque filleul inscrit : +{data.rewards.referrer}</li>
        </ul>
      </div>
    </div>
  );
}

function ApiTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<{ key: string } | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    api<ApiKey[]>("/account/apikeys").then(setKeys).catch(() => {});
  };
  useEffect(load, []);
  const create = async () => {
    setError("");
    try {
      const r = await post<{ key: string }>("/account/apikeys", { label: label || "Clé API" });
      setCreated(r);
      setLabel("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Clés API</h2>
        <p className="muted">Pour les SGI, institutionnels et développeurs : accédez à la cote, aux carnets, aux signaux et à votre portefeuille depuis vos propres outils. Envoyez la clé dans l'en-tête <code>X-API-Key</code>.</p>
        <div className="field"><label>Libellé</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Terminal SGI, tableau Excel…" /></div>
        <button className="btn primary" onClick={create}>Générer une clé</button>
        {error && <div className="error">{error}</div>}
        {created && (
          <div style={{ marginTop: 10 }}>
            <p className="success">Copiez cette clé maintenant : elle ne sera plus affichée.</p>
            <code className="key">{created.key}</code>
          </div>
        )}
        <table style={{ marginTop: 12 }}>
          <thead><tr><th className="left">Libellé</th><th className="left">Préfixe</th><th>Créée</th><th>Dernier usage</th><th></th></tr></thead>
          <tbody>{keys.map((k) => <tr key={k.id}><td className="left">{k.label}</td><td className="left mono">{k.prefix}…</td><td className="mono muted">{fmtDateTime(k.createdAt)}</td><td className="mono muted">{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : "—"}</td><td><button className="btn sm" onClick={() => del(`/account/apikeys/${k.id}`).then(load)}>Révoquer</button></td></tr>)}</tbody>
        </table>
      </div>
      <div className="card">
        <h2>Exemple</h2>
        <pre style={{ fontSize: 12, overflow: "auto", background: "var(--bg)", padding: 10, borderRadius: 6 }}>{`curl -H "X-API-Key: cm_votre_cle" \\
  ${location.origin}/api/market/quotes

curl -H "X-API-Key: cm_votre_cle" \\
  ${location.origin}/api/market/book/SNTS

curl -H "X-API-Key: cm_votre_cle" \\
  ${location.origin}/api/portfolio

# Flux temps réel
wscat -c "${location.origin.replace("http", "ws")}/ws?token=<jeton>"`}</pre>
        <p className="muted" style={{ fontSize: 12 }}>Routes principales : <code>/api/market/quotes</code>, <code>/api/market/history/:symbole</code>, <code>/api/market/book/:symbole</code>, <code>/api/market/signals</code>, <code>/api/market/events</code>, <code>/api/advisor/recommendations</code>, <code>/api/portfolio/orders</code>.</p>
      </div>
    </div>
  );
}
