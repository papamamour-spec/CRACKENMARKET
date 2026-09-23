import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { MarketProvider } from "./hooks/useMarket";
import { ThemeProvider } from "./hooks/useTheme";
import { AdvisorPage } from "./pages/AdvisorPage";
import { AlertsPage } from "./pages/AlertsPage";
import { BacktestPage } from "./pages/BacktestPage";
import { DashboardPage } from "./pages/DashboardPage";
import { InstrumentPage } from "./pages/InstrumentPage";
import { LoginPage } from "./pages/LoginPage";
import { MarketPage } from "./pages/MarketPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { ProfilePage } from "./pages/ProfilePage";
import { LandingPage } from "./pages/LandingPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { NewsPage } from "./pages/NewsPage";
import { PerformancePage } from "./pages/PerformancePage";
import { AccountPage } from "./pages/AccountPage";
import { PublicProfilePage } from "./pages/PublicProfilePage";
import { SgiPage } from "./pages/SgiPage";
import { SgiConsolePage } from "./pages/SgiConsolePage";
import { AdvisoryRequestPage } from "./pages/AdvisoryRequestPage";
import { AnalystInboxPage } from "./pages/AnalystInboxPage";

function Protected() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth card">Chargement…</div>;
  if (!user) return <Navigate to="/bienvenue" replace />;
  return (
    <MarketProvider>
      <Layout />
    </MarketProvider>
  );
}

/** Accueil : cote publique pour les visiteurs, tableau de bord pour les membres. */
function Public() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth card">Chargement…</div>;
  if (user) return <Navigate to="/" replace />;
  return (
    <MarketProvider>
      <LandingPage />
    </MarketProvider>
  );
}

export function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/connexion" element={<LoginPage />} />
          <Route path="/bienvenue" element={<Public />} />
          <Route element={<Protected />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/marche" element={<MarketPage />} />
            <Route path="/valeur/:symbol" element={<InstrumentPage />} />
            <Route path="/conseiller" element={<AdvisorPage />} />
            <Route path="/portefeuille" element={<PortfolioPage />} />
            <Route path="/alertes" element={<AlertsPage />} />
            <Route path="/backtest" element={<BacktestPage />} />
            <Route path="/profil" element={<ProfilePage />} />
            <Route path="/classement" element={<LeaderboardPage />} />
            <Route path="/investisseur/:id" element={<PublicProfilePage />} />
            <Route path="/actualites" element={<NewsPage />} />
            <Route path="/performance" element={<PerformancePage />} />
            <Route path="/compte" element={<AccountPage />} />
            <Route path="/conseil" element={<AdvisoryRequestPage />} />
            <Route path="/conseil/analyste" element={<AnalystInboxPage />} />
            <Route path="/sgi" element={<SgiPage />} />
            <Route path="/sgi/console" element={<SgiConsolePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  );
}
