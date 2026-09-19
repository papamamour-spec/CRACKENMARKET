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
  const services = { db, auth, market, portfolios, advisor, alerts };

  const app = express();
  app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") }));
  app.use(express.json());
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
