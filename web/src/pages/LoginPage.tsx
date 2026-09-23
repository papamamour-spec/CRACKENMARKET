import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ThemeToggle } from "../components/ThemeToggle";

const ROLES = [
  { value: "investor", label: "Investisseur particulier" },
  { value: "sgi", label: "SGI (Société de Gestion et d'Intermédiation)" },
  { value: "institutional", label: "Investisseur institutionnel" },
  { value: "analyst", label: "Analyste financier" },
];

export function LoginPage() {
  const { login, register, verify2fa } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">(params.get("inscription") ? "register" : "login");
  const [referral, setReferral] = useState(params.get("parrain") ?? "");
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("investor");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (tempToken) {
        await verify2fa(tempToken, code);
        nav("/");
        return;
      }
      if (mode === "login") {
        const t = await login(email, password);
        if (t) {
          setTempToken(t);
          return;
        }
      } else await register(email, password, fullName, role, referral);
      nav(mode === "register" ? "/profil" : "/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}><ThemeToggle /></div>
      <div className="brand">Cracken<span>Market</span></div>
      <div className="card">
        <div className="tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Connexion</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Créer un compte</button>
        </div>
        {tempToken ? (
          <form onSubmit={submit}>
            <p>Entrez le code à 6 chiffres de votre application d'authentification.</p>
            <div className="field"><label>Code 2FA</label><input value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="123 456" /></div>
            {error && <div className="error">{error}</div>}
            <button className="btn primary" style={{ width: "100%" }} disabled={busy}>Valider</button>
            <button type="button" className="btn" style={{ width: "100%", marginTop: 8 }} onClick={() => setTempToken(null)}>Retour</button>
          </form>
        ) : (
        <form onSubmit={submit}>
          {mode === "register" && (
            <>
              <div className="field"><label>Nom complet</label><input value={fullName} onChange={(e) => setFullName(e.target.value)} required /></div>
              <div className="field">
                <label>Vous êtes</label>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            </>
          )}
          <div className="field"><label>E-mail</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label>Mot de passe</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} /></div>
          {mode === "register" && <div className="field"><label>Code de parrainage (facultatif)</label><input value={referral} onChange={(e) => setReferral(e.target.value.toUpperCase())} placeholder="CM-XXXXXX" /></div>}
          {error && <div className="error">{error}</div>}
          <button className="btn primary" style={{ width: "100%" }} disabled={busy}>{mode === "login" ? "Se connecter" : "Créer mon compte"}</button>
        </form>
        )}
        <p style={{ textAlign: "center", marginTop: 12, fontSize: 12 }}><Link to="/">← Retour à la cote publique</Link></p>
        <p className="disclaimer">Plateforme de conseil en investissement sur la BRVM : demandes de placement pour les particuliers et les SGI, propositions relues par un analyste, exécution par une SGI agréée. Un portefeuille virtuel de 5 000 000 FCFA permet de s'entraîner. Les conseils ne constituent pas une recommandation personnalisée au sens réglementaire.</p>
      </div>
    </div>
  );
}
