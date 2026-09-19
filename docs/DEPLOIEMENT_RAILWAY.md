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
