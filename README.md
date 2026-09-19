# CrackenMarket – Plateforme boursière BRVM avec conseiller algorithmique

CrackenMarket est une plateforme de suivi de marché et d'aide à la décision dédiée à la
**BRVM** (Bourse Régionale des Valeurs Mobilières de l'UEMOA), dans l'esprit de ProRealTime
(graphiques et analyse technique) et de RichBourse (suivi de la cote, portefeuille).

Son moteur **Kraken** croise l'historique de marché de chaque valeur et le comportement
observé de l'investisseur pour produire des recommandations personnalisées, mises à jour à
chaque cotation.

## Fonctionnalités

| Domaine | Détail |
| --- | --- |
| Cote temps réel | 46 valeurs de la BRVM, indices BRVM Composite et BRVM 30, palmarès, secteurs, bandeau défilant, diffusion WebSocket |
| Graphiques | Chandeliers intraday / jour / semaine / mois, volumes, MM20/50/200, Bollinger, sous-fenêtres RSI et MACD, mise à jour tick par tick |
| Analyse technique | RSI, MACD, Bollinger, ATR, stochastique, OBV, volatilité, drawdown, Sharpe, supports/résistances, scores tendance / momentum / retour à la moyenne / volumes / risque |
| Conseiller Kraken | Recommandation par valeur (ACHAT FORT → ÉVITER), score, confiance, adéquation au profil, objectif et stop par ATR, taille de position par budget de risque, explications en français |
| Profil comportemental | Questionnaire + analyse des ordres : sur-activité, effet de disposition, concentration, achats après hausse, ventes paniques, inactivité. Score de discipline, tolérance effective, pondérations adaptées |
| Portefeuille | Portefeuille virtuel (5 000 000 FCFA à l'inscription), ordres au marché et à cours limité, frais BRVM, positions valorisées en temps réel, P&L réalisé / latent |
| Diagnostic & allocation | Santé, diversification, risque, exposition sectorielle, rééquilibrage suggéré, allocation cible |
| Suivi & alertes | Liste de suivi, alertes de cours (seuil haut / bas / variation %), notifications temps réel |
| Backtest | Croisement de moyennes mobiles, retour à la moyenne RSI, MACD, acheter-conserver ; courbe de capital et signaux |
| Acteurs | Rôles investisseur, SGI, institutionnel, analyste |
| Interface | Mode sombre et mode clair (bouton dans la barre supérieure, préférence mémorisée, réglage système respecté par défaut), graphiques adaptés au thème |

## Architecture

```
crackenmarket/
├── server/            API Node.js (Express + WebSocket + SQLite)
│   ├── src/data/      référentiel BRVM et fournisseurs de données (live / simulation)
│   ├── src/engine/    indicateurs, analyse technique, profil comportemental, conseiller, backtest
│   ├── src/services/  marché, portefeuille, conseiller, alertes, authentification
│   ├── src/routes/    API REST (/api)
│   └── src/ws.ts      diffusion temps réel (/ws)
├── web/               interface React + Vite + lightweight-charts
└── docs/              documentation technique
```

### Données de marché

La BRVM ne publie pas d'API publique. Le fournisseur `live` (`server/src/data/providers/live.ts`)
lit la cote officielle sur brvm.org (secours : Sikafinance) à intervalle régulier et ne diffuse
que les changements. Si la source est injoignable, la plateforme bascule automatiquement sur
le fournisseur `simulation`, qui rejoue un marché réaliste (mouvement brownien géométrique par
régimes, liquidité propre à chaque valeur, pas de cotation BRVM) ancré sur les prix de référence.
L'indicateur d'état dans la barre supérieure précise la source utilisée.

Pour brancher un flux officiel (SGI, BRVM Data), implémentez l'interface `MarketDataProvider`
(`server/src/data/providers/types.ts`).

## Démarrage rapide

Prérequis : Node.js ≥ 20.

```bash
npm install
npm run dev          # API sur http://localhost:4000, interface sur http://localhost:5173
```

Production :

```bash
npm run build
npm start            # sert l'API, le WebSocket et l'interface compilée sur le port 4000
```

Railway : voir `docs/DEPLOIEMENT_RAILWAY.md` (Dockerfile détecté automatiquement, volume à monter sur `/data`).

Docker :

```bash
docker compose up --build
```

Variables d'environnement (voir `server/.env.example`) : `PORT`, `JWT_SECRET`,
`DATA_PROVIDER` (`auto` | `live` | `simulation`), `LIVE_POLL_INTERVAL_MS`, `SIM_TICK_INTERVAL_MS`,
`DB_PATH`, `CORS_ORIGIN`, `HISTORY_DAYS`.

## Tests

```bash
npm test             # tests unitaires du moteur (indicateurs, profil, conseiller, backtest)
npm run typecheck
```

## API (extraits)

| Méthode | Route | Description |
| --- | --- | --- |
| POST | `/api/auth/register`, `/api/auth/login` | Création de compte, connexion (JWT) |
| GET | `/api/market/quotes`, `/api/market/indices`, `/api/market/movers` | Cote, indices, palmarès |
| GET | `/api/market/history/:symbol?timeframe=1m|1D|1W|1M` | Historique + séries d'indicateurs |
| GET | `/api/market/technical/:symbol`, `/api/market/screener` | Analyse technique, screener |
| GET/PUT | `/api/profile` · GET `/api/profile/behavior` | Questionnaire, profil comportemental |
| GET | `/api/advisor/recommendations[/:symbol]`, `/api/advisor/portfolio` | Recommandations, diagnostic et allocation |
| GET/POST/DELETE | `/api/portfolio`, `/api/portfolio/orders` | Portefeuille, ordres |
| GET/POST/DELETE | `/api/watchlist/:symbol`, `/api/alerts` | Suivi, alertes |
| GET | `/api/backtest/:symbol?strategy=sma_cross` | Backtest |
| WS | `/ws?token=…` | `hello`, `quotes`, `indices`, `status`, `alert`, `order_filled` |

## Avertissement

CrackenMarket est un outil d'aide à la décision. Les recommandations produites par
l'algorithme ne constituent pas un conseil en investissement au sens de la réglementation
de l'AMF-UMOA. Les ordres passés sur la plateforme sont virtuels ; les ordres réels doivent être
transmis à une SGI agréée.
