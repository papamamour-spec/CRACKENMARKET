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

function Protected() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth card">Chargement…</div>;
  if (!user) return <Navigate to="/connexion" replace />;
  return (
    <MarketProvider>
      <Layout />
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
          <Route element={<Protected />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/marche" element={<MarketPage />} />
            <Route path="/valeur/:symbol" element={<InstrumentPage />} />
            <Route path="/conseiller" element={<AdvisorPage />} />
            <Route path="/portefeuille" element={<PortfolioPage />} />
            <Route path="/alertes" element={<AlertsPage />} />
            <Route path="/backtest" element={<BacktestPage />} />
            <Route path="/profil" element={<ProfilePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  );
}
