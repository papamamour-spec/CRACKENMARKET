# Déployer CrackenMarket sur Railway

Railway détecte le `Dockerfile` à la racine (déclaré dans `railway.json`) : l'image compile
le serveur et l'interface, puis sert le tout sur un seul port (API, WebSocket et front).

## Étapes

1. **Créer le projet** : Railway → *New Project* → *Deploy from GitHub repo* → choisir
   `CRACKENMARKET` (branche `main`).
2. **Vérifier les réglages du service** (Service → *Settings*). Railway détecte parfois le
   monorepo comme un service « @crackenmarket/web » et y ajoute des commandes personnalisées
   qui font échouer le déploiement. Les valeurs attendues sont :

   | Réglage | Valeur attendue |
   | --- | --- |
   | *Builder* | Dockerfile |
   | *Dockerfile Path* | `/Dockerfile` |
   | *Root Directory* | vide (racine du dépôt) |
   | *Build Command* | **vide** (supprimer `npm run build --workspace=@crackenmarket/web`) |
   | *Start Command* | **vide** ou `node dist/index.js` (supprimer `npm run dev --workspace=@crackenmarket/web`) |
   | *Watch Paths* | **vide** (supprimer `/web/**`, sinon les changements du serveur ne redéploient pas) |

   Le fichier `railway.json` du dépôt fixe déjà le builder, le chemin du Dockerfile, la commande
   de démarrage et le healthcheck ; les réglages du tableau de bord ne doivent pas les contredire.
3. **Ajouter un volume** (Service → *Volumes* → *Add Volume*) monté sur `/data`.
   La base SQLite (`/data/crackenmarket.db`) survit ainsi aux redéploiements.
4. **Variables d'environnement** (Service → *Variables*) :

   | Variable | Valeur recommandée | Rôle |
   | --- | --- | --- |
   | `JWT_SECRET` | une chaîne aléatoire longue (obligatoire) | signature des jetons de session |
   | `DATA_PROVIDER` | `auto` | cote BRVM en direct si joignable, sinon simulation |
   | `LIVE_POLL_INTERVAL_MS` | `15000` | fréquence de lecture de la cote officielle |
   | `SIM_TICK_INTERVAL_MS` | `2000` | fréquence des ticks simulés |
   | `DB_PATH` | `/data/crackenmarket.db` | chemin de la base (déjà défini dans l'image) |
   | `CORS_ORIGIN` | `*` | front et API servis par le même domaine |
   | `PRIVATE_MODE` | `1` | plateforme réservée à son propriétaire : aucune inscription, le seul compte est `ADMIN_EMAIL` ; `0` pour rouvrir les inscriptions et les fonctions communautaires |
   | `ADMIN_EMAIL` | e-mail de l'administrateur | avec `ADMIN_PASSWORD`, crée le compte administrateur au démarrage (en mode privé, c'est l'unique compte) |
   | `ADMIN_PASSWORD` | mot de passe (8 caractères minimum) | ne jamais l'écrire dans le dépôt ; changer la variable réinitialise le mot de passe |
   | `FORECAST_BACKFILL_SESSIONS` | `120` | profondeur de l'amorçage de l'apprentissage continu (prévisions rejouées sur l'historique au premier démarrage ; `0` pour désactiver) |
   | `DOC_SOURCES_JSON` | (facultatif) `[{"name":"…","url":"https://…/{symbol}","perCompany":true}]` | sources supplémentaires de documents de sociétés |
   | `FEES_JSON` | grille par défaut | frais d'un ordre : `{"brokeragePct":0.8,"brvmPct":0.1,"dcbrPct":0.05,"vatPct":18,"minFee":2500}` |
   | `DIVIDEND_TAX_JSON` | table par défaut | retenue à la source sur dividendes par pays : `{"CI":10,"SN":10,"BF":6}` |
   | `BOC_AUTO` | `1` | collecte automatique des bulletins officiels quotidiens sur brvm.org (`0` pour désactiver) |
   | `HISTORY_COLLECT` | `1` | collecte quotidienne de l'historique réel des cours et des capitalisations sur Sika Finance (`0` pour désactiver) |
   | `QUALITY_AUTO` | `1` | contrôles de qualité des données et rapport du jour automatiques après la clôture ; `0` : à la demande seulement |
   | `MODELS_AUTO` | `1` | calcul automatique des portefeuilles modèles (au démarrage puis chaque jour après la clôture) ; `0` : à la demande seulement |
   | `ANTHROPIC_API_KEY` | (facultatif) | clé de l'API Claude : active la lecture des publications par modèle de langage (fondamentaux et événements extraits du texte complet des documents) ; sans clé, seul le lecteur à règles fonctionne |
   | `LLM_MODEL` | `claude-opus-5-5` | modèle utilisé pour la lecture des publications |
   | `LLM_EXTRACT_DAILY_MAX` | `25` | nombre maximal de publications soumises au modèle par jour (`0` : sans limite) |
   | `LLM_AUTO` | `1` | passages automatiques (démarrage, après chaque téléchargement de publications, toutes les six heures) ; `0` : à la demande seulement |
   | `FUNDAMENTALS_FETCH` | `1` | téléchargement automatique du corps des publications pour en extraire les fondamentaux (`0` : titres seuls) |
   | `DOC_COLLECT` | `1` | collecte des rapports, annonces et communiqués des sociétés (`0` pour désactiver) |
   | `BOC_SOURCES` | (facultatif) `https://…/boc_{YYYYMMDD}.pdf,https://…/cote?date={DD-MM-YYYY}` | modèles d'URL du bulletin officiel de la cote (PDF ou HTML), collectés toutes les heures pour les dernières séances closes ; sans cette variable, le bulletin s'importe par collage dans « Données officielles » |
   | `BOC_COLUMNS` | (facultatif) `volume,ref,open,close,changePct,trades` | ordre des colonnes d'un bulletin sans ligne d'en-tête reconnue (champs : ref, open, high, low, close, changePct, volume, value, trades, bid, bidQty, ask, askQty, skip) |
   | `BOND_SOURCES` | `https://www.brvm.org/fr/cours-obligations/0` | page(s) de la cote obligataire collectée(s) toutes les 30 minutes (séparées par des virgules) |
   | `RISK_FREE_RATE` | `0.06` | taux sans risque annuel (obligations d'État UEMOA, indicatif) utilisé par l'optimiseur |
   | `NEWS_FEEDS` | (facultatif) `https://…/feed,https://…/rss` | flux RSS supplémentaires pour la veille |
   | `NEWS_SOURCES_JSON` | (facultatif) `[{"name":"…","url":"…","kind":"html-list","weight":0.7}]` | sources HTML ou RSS supplémentaires avec crédibilité |

   `PORT` est injecté automatiquement par Railway et lu par le serveur.
5. **Générer un domaine** (le service est « non exposé » tant que ce n'est pas fait) : Service → *Settings* → *Networking* → *Generate Domain*.
   Le WebSocket fonctionne sur le même domaine (`wss://…/ws`), sans configuration supplémentaire.
6. **Vérifier** : `https://<votre-domaine>/api/health` doit répondre `{"ok":true,…}` et indiquer
   le fournisseur de données actif (`live` ou `simulation`).

## Remarques

- Le `Dockerfile` ne contient volontairement pas d'instruction `VOLUME` : le validateur de
  Railway la refuse (« docker VOLUME … is not supported, use Railway Volumes ») et le build
  échoue avant même de commencer. Le montage se fait exclusivement via un Railway Volume.

- Le plan gratuit de Railway met le service en veille après inactivité ; le flux temps réel
  redémarre à la première connexion et l'historique est rechargé depuis le volume.
- Pour forcer la cote officielle, mettez `DATA_PROVIDER=live` ; le serveur bascule en simulation
  avec un avertissement dans les logs si brvm.org est injoignable depuis Railway.
- Le déploiement à partir de Docker Compose (`docker compose up --build`) reste possible sur
  n'importe quel autre hébergeur.
