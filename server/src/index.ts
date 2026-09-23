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
  const services = { db, auth, market, portfolios, advisor, alerts, social, signals, sgi, advisory, news };
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
