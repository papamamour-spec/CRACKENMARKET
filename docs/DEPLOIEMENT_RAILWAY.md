# Déployer CrackenMarket sur Railway

Railway détecte le `Dockerfile` à la racine (déclaré dans `railway.json`) : l'image compile
le serveur et l'interface, puis sert le tout sur un seul port (API, WebSocket et front).

## Étapes

1. **Créer le projet** : Railway → *New Project* → *Deploy from GitHub repo* → choisir
   `CRACKENMARKET` (branche `main` une fois la PR fusionnée).
2. **Ajouter un volume** (Service → *Volumes* → *Add Volume*) monté sur `/data`.
   La base SQLite (`/data/crackenmarket.db`) survit ainsi aux redéploiements.
3. **Variables d'environnement** (Service → *Variables*) :

   | Variable | Valeur recommandée | Rôle |
   | --- | --- | --- |
   | `JWT_SECRET` | une chaîne aléatoire longue (obligatoire) | signature des jetons de session |
   | `DATA_PROVIDER` | `auto` | cote BRVM en direct si joignable, sinon simulation |
   | `LIVE_POLL_INTERVAL_MS` | `15000` | fréquence de lecture de la cote officielle |
   | `SIM_TICK_INTERVAL_MS` | `2000` | fréquence des ticks simulés |
   | `DB_PATH` | `/data/crackenmarket.db` | chemin de la base (déjà défini dans l'image) |
   | `CORS_ORIGIN` | `*` | front et API servis par le même domaine |

   `PORT` est injecté automatiquement par Railway et lu par le serveur.
4. **Générer un domaine** : Service → *Settings* → *Networking* → *Generate Domain*.
   Le WebSocket fonctionne sur le même domaine (`wss://…/ws`), sans configuration supplémentaire.
5. **Vérifier** : `https://<votre-domaine>/api/health` doit répondre `{"ok":true,…}` et indiquer
   le fournisseur de données actif (`live` ou `simulation`).

## Remarques

- Le plan gratuit de Railway met le service en veille après inactivité ; le flux temps réel
  redémarre à la première connexion et l'historique est rechargé depuis le volume.
- Pour forcer la cote officielle, mettez `DATA_PROVIDER=live` ; le serveur bascule en simulation
  avec un avertissement dans les logs si brvm.org est injoignable depuis Railway.
- Le déploiement à partir de Docker Compose (`docker compose up --build`) reste possible sur
  n'importe quel autre hébergeur.
