import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { buildRouter } from "./routes/index.js";
import { errorHandler } from "./routes/middleware.js";
import { AdvisorService } from "./services/advisor.js";
import { AlertService } from "./services/alerts.js";
import { AuthService } from "./services/auth.js";
import { MarketService } from "./services/market.js";
import { PortfolioService } from "./services/portfolio.js";
import { SignalService } from "./services/signals.js";
import { SocialService } from "./services/social.js";
import { SgiService } from "./services/sgi.js";
import { AdvisoryService } from "./services/advisory.js";
import { NewsService } from "./services/news.js";
import { ForecastService } from "./services/forecast.js";
import { LearningService } from "./services/learning.js";
import { HoldingsService } from "./services/holdings.js";
import { TrackingService } from "./services/tracking.js";
import { BondService } from "./services/bonds.js";
import { DocumentService } from "./services/documents.js";
import { QualityService } from "./services/quality.js";
import { RadarService } from "./services/radar.js";
import { CorporateService } from "./services/corporate.js";
import { BocService } from "./services/boc.js";
import { EvaluationService } from "./services/evaluation.js";
import { FundamentalsService } from "./services/fundamentals.js";
import { PanelService } from "./services/panel.js";
import { HistoryService } from "./services/history.js";
import { attachWebSocket } from "./ws.js";

async function main(): Promise<void> {
  const db = getDb();
  const market = new MarketService(db);
  await market.start();
  const auth = new AuthService(db);
  auth.ensureAdmin(config.adminEmail, config.adminPassword);
  const portfolios = new PortfolioService(db, market);
  const advisor = new AdvisorService(db, market, portfolios);
  const alerts = new AlertService(db);
  const social = new SocialService(db, portfolios);
  const signals = new SignalService(db, market, advisor);
  const sgi = new SgiService(db, market);
  const advisory = new AdvisoryService(db, market, advisor);
  const news = new NewsService(db);
  advisor.attachNews(news);
  advisory.attachNews(news);
  news.start();
  const forecasts = new ForecastService(market, advisor);
  const learning = new LearningService(db, market);
  forecasts.attachLearning(learning);
  advisory.attachForecasts(forecasts);
  const holdings = new HoldingsService(db, market, advisor, portfolios);
  holdings.attachForecasts(forecasts);
  const bonds = new BondService(db);
  holdings.attachBonds(bonds);
  advisory.attachBonds(bonds);
  bonds.start();
  const documents = new DocumentService(db);
  documents.attachNews(news);
  documents.start();
  const corporate = new CorporateService(db, market);
  corporate.attach(news, documents);
  advisor.attachCorporate(corporate);
  const boc = new BocService(db, market);
  boc.attach(bonds, corporate, news);
  boc.start();
  const history = new HistoryService(db, market);
  forecasts.attachOfficial(corporate, boc);
  const quality = new QualityService(db, market, advisor);
  quality.attach(documents, news);
  quality.attachCorporate(corporate);
  holdings.attachQuality(quality);
  const radar = new RadarService(db, news, documents, bonds);
  radar.attachCorporate(corporate);
  radar.start();
  forecasts.start();
  learning.start();
  const fundamentals = new FundamentalsService(db, market);
  fundamentals.attach(documents, news, quality);
  fundamentals.attachBoc(boc);
  history.attachQuality(quality);
  history.start();
  const panel = new PanelService(market);
  panel.attach(corporate, fundamentals);
  forecasts.attachPanel(panel);
  panel.start();
  advisory.attachQuality(quality);
  const evaluation = new EvaluationService(db, market);
  evaluation.attachExtras(panel.extrasAt);
  const tracking = new TrackingService(db, market);
  const services = { db, auth, market, portfolios, advisor, alerts, social, signals, sgi, advisory, news, forecasts, learning, holdings, bonds, documents, quality, radar, corporate, boc, evaluation, fundamentals, panel, history, tracking };
  signals.start();
  // Instantanés de valorisation : au démarrage puis toutes les 15 minutes (idempotent par jour)
  portfolios.snapshotAll();
  setInterval(() => portfolios.snapshotAll(), 15 * 60_000);

  const app = express();
  app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") }));
  // corps brut conservé pour vérifier les signatures des webhooks SGI
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: string }).rawBody = buf.toString(); } }));
  app.use("/api", buildRouter(services));

  // Frontend compilé (web/dist) servi en production
  const webDist = path.resolve(process.cwd(), "../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }
  app.use(errorHandler);

  const server = http.createServer(app);
  attachWebSocket(server, services);
  server.listen(config.port, () => {
    console.log(`[server] CrackenMarket API : http://localhost:${config.port}/api  |  WS : ws://localhost:${config.port}/ws`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
