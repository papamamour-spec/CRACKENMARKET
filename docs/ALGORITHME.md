# Moteur de conseil Kraken

## 1. Analyse de l'historique de marché (`server/src/engine/technical.ts`)

Pour chaque valeur, 400 séances quotidiennes alimentent :

| Famille | Indicateurs | Score [-1, 1] |
| --- | --- | --- |
| Tendance | position du cours vs MM20 / MM50 / MM200, MM50 vs MM200, pente de régression 50 séances | `trend` |
| Momentum | RSI 14, histogramme MACD normalisé par l'ATR, performance 1 mois | `momentum` |
| Retour à la moyenne | RSI < 30 / > 70, %B de Bollinger hors bandes | `meanReversion` |
| Volumes | volume 5 séances / 60 séances, pente de l'OBV | `volume` |
| Risque | volatilité annualisée 60 séances, drawdown maximal 1 an | `risk` (1 = calme) |

Le score composite marché (screener) pondère 35 % tendance, 30 % momentum, 15 % retour à la
moyenne, 10 % volumes, 10 % risque. Des signaux textuels (croisement doré, survente, cassure de
support, volumes anormaux…) sont générés pour l'explication.

## 2. Profil comportemental (`server/src/engine/behavior.ts`)

Entrées : questionnaire déclaré (tolérance 1–5, horizon, objectif, expérience, secteurs), historique
des transactions, événements (consultations, ordres annotés, suivi des conseils), positions.

Biais détectés et effet sur le profil :

| Biais | Détection | Effet |
| --- | --- | --- |
| Sur-activité | ordres/mois > 1,5 × attendu pour l'horizon | tolérance effective −0,5 |
| Effet de disposition | gains coupés 40 % plus vite que les pertes | conseil de discipline |
| Concentration | ligne > 40 % ou secteur > 60 % | rééquilibrage |
| Achats après hausse | > 40 % des achats après +8 % en 5 séances | tolérance −0,5, avertissement sur les valeurs en hausse |
| Ventes paniques | > 40 % des ventes après −6 % en 5 séances | tolérance −1 |
| Inactivité | consultations sans ordre | suggestion de première ligne |

Le style résultant (Prudent, Équilibré, Dynamique, Spéculatif) définit les pondérations du score
personnalisé, y compris le poids du rendement du dividende (objectif « revenus »).

## 3. Recommandation (`server/src/engine/advisor.ts`)

1. Score brut = Σ (score technique × pondération du style) + score dividende.
2. Adéquation profil/valeur (0–100) : volatilité vs tolérance, secteurs préférés, objectif,
   liquidité, horizon. Le score brut est atténué par l'adéquation ; une adéquation < 35 plafonne
   l'avis.
3. Contexte portefeuille : une ligne > 25 % ne peut plus être renforcée.
4. Action : ACHAT FORT ≥ 45, ACHAT ≥ 18, CONSERVER > −15, ALLÉGER > −40 (si détenue), VENTE,
   ÉVITER (non détenue ou adéquation < 30).
5. Objectif = max(résistance 60 séances, cours + k × 1,8 × ATR), stop = max(support × 0,98,
   cours − k × ATR), k = 2 / 2,5 / 3 selon la tolérance.
6. Taille de position = min(budget de risque (0,5 % à 3 % du capital) / risque par titre,
   poids max de ligne, liquidités disponibles).
7. Confiance = accord entre tendance, momentum et volumes, volatilité, intensité du score.

## 4. Diagnostic de portefeuille

Diversification (indice de Herfindahl sur lignes et secteurs), risque (volatilité pondérée +
concentration), santé globale, liquidités cibles selon le profil, rééquilibrage (vendre / alléger /
renforcer / initier) et allocation cible (max. 3 valeurs par secteur, 6–8 lignes, réserve de
liquidités).

## 5. Temps réel

Chaque cotation reçue du fournisseur met à jour la bougie du jour, invalide le cache technique
de la valeur, réévalue les ordres limites et les alertes, puis est diffusée par WebSocket. Les
recommandations sont recalculées à la demande sur les données à jour (cache de 60 s par valeur).

## 6. Signaux, carnet et exécution des ordres

- **Flux de signaux** (`server/src/services/signals.ts`) : toutes les 5 minutes, les signaux
  textuels de l'analyse technique de chaque valeur sont comparés aux signaux publiés dans les
  24 dernières heures ; les nouveaux sont persistés et diffusés. Les variations de séance
  supérieures à 5 % sont publiées immédiatement.
- **Carnet d'ordres** (`server/src/services/orderbook.ts`) : la BRVM ne diffuse pas sa
  profondeur en accès public. Le carnet est reconstitué à chaque cotation autour du dernier
  cours (pas de cotation, écart fonction de la liquidité, tailles décroissantes, déséquilibre
  aléatoire persistant) et signalé comme « estimé » dans l'interface. Un flux officiel se
  branche en remplaçant `buildOrderBook`.
- **Ordres** (`server/src/services/portfolio.ts`) : marché, limite, stop, stop-limite ; un
  stop-limite déclenché devient une limite. Les ordres liés (objectif + stop de protection)
  sont créés à l'exécution d'un achat dans un même groupe OCO ; l'exécution de l'un annule
  l'autre. Les ordres « jour » expirent au changement de journée UTC.
