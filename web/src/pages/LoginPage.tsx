import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const ROLES = [
  { value: "investor", label: "Investisseur particulier" },
  { value: "sgi", label: "SGI (Société de Gestion et d'Intermédiation)" },
  { value: "institutional", label: "Investisseur institutionnel" },
  { value: "analyst", label: "Analyste financier" },
];

export function LoginPage() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
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
      if (mode === "login") await login(email, password);
      else await register(email, password, fullName, role);
      nav(mode === "register" ? "/profil" : "/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="brand">Cracken<span>Market</span></div>
      <div className="card">
        <div className="tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Connexion</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Créer un compte</button>
        </div>
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
          {error && <div className="error">{error}</div>}
          <button className="btn primary" style={{ width: "100%" }} disabled={busy}>{mode === "login" ? "Se connecter" : "Créer mon compte"}</button>
        </form>
        <p className="disclaimer">Plateforme d'aide à la décision sur la BRVM. Chaque nouveau compte reçoit un portefeuille virtuel de 5 000 000 FCFA pour s'entraîner. Les conseils générés ne constituent pas une recommandation d'investissement personnalisée au sens réglementaire.</p>
      </div>
    </div>
  );
}
