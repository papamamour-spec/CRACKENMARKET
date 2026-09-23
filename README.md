# CrackenMarket – Conseil en investissement sur la BRVM

CrackenMarket est une plateforme de **conseil en investissement** dédiée à la **BRVM** (Bourse
Régionale des Valeurs Mobilières de l'UEMOA). Particuliers, institutionnels et SGI y déposent
leurs demandes de placement ; le moteur Kraken produit une allocation motivée et chiffrée, relue
par un analyste, que la SGI du client exécute. Le suivi de marché, les graphiques et la
négociation restent disponibles au second plan.

Son moteur **Kraken** croise l'historique de marché de chaque valeur et le comportement
observé de l'investisseur pour produire des recommandations personnalisées, mises à jour à
chaque cotation.

## Fonctionnalités

| Domaine | Détail |
| --- | --- |
| Guichet de conseil | Demande de placement (capital, objectif, horizon, risque, contraintes, portefeuille existant) pour les particuliers et, pour les SGI, au nom de leurs clients ; rapport Kraken : allocation valeur par valeur, rendement de dividende, performance visée, volatilité, scénarios à l'horizon, diagnostic de l'existant ; revue, annotation et validation par un analyste ; aperçu avant envoi, impression PDF |
| Veille d'actualité | Collecte périodique BRVM et presse financière (RSS ou HTML, sources configurables), rattachement aux valeurs par dictionnaire d'alias, sentiment lexical français ; le sentiment récent tempère les recommandations (± 12 points, avertissement) et relève la réserve de liquidités des rapports en cas d'actualité de place défavorable ; ajout manuel par les analystes |
| Cote temps réel | 46 valeurs de la BRVM, indices BRVM Composite et BRVM 30, palmarès, secteurs, bandeau défilant, diffusion WebSocket |
| Graphiques | Chandeliers intraday / jour / semaine / mois, volumes, MM20/50/200, Bollinger, sous-fenêtres RSI et MACD, mise à jour tick par tick |
| Analyse technique | RSI, MACD, Bollinger, ATR, stochastique, OBV, volatilité, drawdown, Sharpe, supports/résistances, scores tendance / momentum / retour à la moyenne / volumes / risque |
| Conseiller Kraken | Recommandation par valeur (ACHAT FORT → ÉVITER), score, confiance, adéquation au profil, objectif et stop par ATR, taille de position par budget de risque, explications en français |
| Profil comportemental | Questionnaire + analyse des ordres : sur-activité, effet de disposition, concentration, achats après hausse, ventes paniques, inactivité. Score de discipline, tolérance effective, pondérations adaptées |
| Portefeuille | Portefeuille virtuel (5 000 000 FCFA à l'inscription), ordres au marché et à cours limité, frais BRVM, positions valorisées en temps réel, P&L réalisé / latent |
| Diagnostic & allocation | Santé, diversification, risque, exposition sectorielle, rééquilibrage suggéré, allocation cible |
| Suivi & alertes | Liste de suivi, alertes de cours (seuil haut / bas / variation %), notifications temps réel |
| Backtest | Croisement de moyennes mobiles, retour à la moyenne RSI, MACD, acheter-conserver ; courbe de capital et signaux |
| Profondeur de marché | Carnet d'ordres 5 niveaux (reconstitué, diffusé en temps réel aux abonnés), déséquilibre acheteurs / vendeurs, transactions au fil de l'eau |
| Ordres avancés | Marché, limite, stop, stop-limite, validité jour / jusqu'à annulation, ordres liés objectif + stop de protection (OCO), expiration automatique |
| Signaux & agenda | Flux de signaux Kraken persistés et diffusés en direct, calendrier indicatif des dividendes, assemblées et publications |
| Social | Classement des investisseurs (mois / total), profils publics anonymisés, suivi et flux des opérations des investisseurs suivis |
| Performance | Instantanés quotidiens, courbe portefeuille vs BRVM Composite, Sharpe, drawdown, taux de réussite, facteur de profit, export CSV |
| Compte | Double authentification TOTP, parrainage avec points, clés API (`X-API-Key`) pour SGI / institutionnels, profil public ou privé |
| Ordres réels via SGI | Ouverture de compte-titres chez une SGI partenaire (Matha Capital), transmission des ordres réels (marché / limite, validité jour / semaine / GTC), suivi d'exécution en temps réel, console de traitement pour le personnel de la SGI, connecteur webhook signé vers le back-office du partenaire |
| Acteurs | Rôles investisseur, SGI, institutionnel, analyste ; page d'accueil publique avec cote en direct ; application installable (PWA) |
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
`DB_PATH`, `CORS_ORIGIN`, `HISTORY_DAYS` (profondeur d'historique en séances, 5 ans soit 1 305 par défaut ;
une base plus courte est prolongée au démarrage), `ADMIN_EMAIL` et `ADMIN_PASSWORD` (compte administrateur
créé au démarrage quand les deux sont définies ; sans elles, aucun compte admin n'existe et le rôle
« admin » n'est pas attribuable depuis l'inscription).

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
| GET | `/api/market/book/:symbol`, `/api/market/signals`, `/api/market/events`, `/api/market/index-history` | Carnet, signaux, agenda, historique des indices |
| GET | `/api/portfolio/performance`, `/api/portfolio/trades.csv` | Performance, export |
| GET/POST/DELETE | `/api/social/leaderboard`, `/api/social/profile/:id`, `/api/social/follow/:id`, `/api/social/activity` | Classement, profils, suivi |
| POST | `/api/auth/2fa/setup`, `/api/auth/2fa/enable`, `/api/auth/2fa/verify` | Double authentification |
| GET/POST/DELETE | `/api/account/apikeys`, GET `/api/account/referrals`, PUT `/api/account/public` | Clés API, parrainage, visibilité |
| GET/POST | `/api/advisory/requests`, `/api/advisory/preview`, `/api/advisory/requests/:id`, `/api/advisory/requests/:id/regenerate` | Demandes de conseil (client ou SGI) et rapports |
| GET/POST | `/api/advisory/inbox`, `/api/advisory/requests/:id/review` | Revue par les analystes |
| GET/POST | `/api/market/news`, `/api/market/news` (analyste), `/api/market/news/refresh` | Veille d'actualité et sentiment |
| GET/POST/DELETE | `/api/sgi/partners`, `/api/sgi/accounts`, `/api/sgi/orders`, `/api/sgi/orders/:id/events` | SGI partenaires, compte-titres, ordres réels |
| GET/POST | `/api/sgi/console`, `/api/sgi/console/orders/:id`, `/api/sgi/console/accounts/:id`, `/api/sgi/staff`, `/api/sgi/webhook/:code` | Console SGI, rattachement du personnel (admin), webhook du back-office |
| WS | `/ws?token=…` | `hello`, `quotes`, `books` (valeurs abonnées via `{"type":"subscribe","symbols":[…]}`), `indices`, `status`, `alert`, `order_filled`, `signal` |

## Avertissement

CrackenMarket est un outil d'aide à la décision. Les recommandations produites par
l'algorithme ne constituent pas un conseil en investissement au sens de la réglementation
de l'AMF-UMOA. Les ordres passés sur la plateforme sont virtuels ; les ordres réels doivent être
transmis à une SGI agréée.
