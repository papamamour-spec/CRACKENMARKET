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

## 7. Guichet de conseil et veille d'actualité

- **Demande de placement** (`server/src/services/advisory.ts`) : la demande (capital, objectif,
  horizon, tolérance, secteurs, contraintes, portefeuille existant) est convertie en profil
  déclaré ; chaque valeur est notée par `recommend`, puis `proposeAllocation` construit
  l'allocation (max. 3 valeurs par secteur, 6 à 8 lignes, réserve de liquidités selon le profil).
  Le rapport agrège rendement de dividende, performance visée sur l'horizon (annualisée),
  volatilité pondérée (moins 20 % d'effet de diversification) et trois scénarios à l'horizon
  (± une volatilité). Un portefeuille existant est diagnostiqué et des actions de rééquilibrage
  proposées. Les analystes relisent, annotent, valident ou écartent ; ils peuvent régénérer le
  rapport avec le marché du jour.
- **Veille d'actualité** (`server/src/services/news.ts`) : sources BRVM et presse financière
  (RSS ou page HTML), rattachement aux valeurs par alias avec frontières de mots, sentiment
  lexical français borné à [-1, 1], agrégation pondérée par la fraîcheur sur 14 jours.
  Dans `recommend`, un sentiment d'au moins ±0,15 déplace le score de ±12 points au maximum,
  ajoute une justification ou un avertissement, et une actualité défavorable réduit la
  confiance. Dans les rapports, un sentiment de place ≤ -0,2 relève la réserve de liquidités de
  5 points et recommande un déploiement progressif.

## 8. Prévision des fluctuations (`server/src/engine/forecast.ts`)

Pour chaque valeur et trois horizons (5, 21 et 63 séances), le moteur produit une **distribution** de rendement, pas un chiffre isolé.

1. **Facteurs** calculés à chaque date sur les données disponibles à cette date : momentum 1 et 3 mois, écart à la moyenne 50 séances, volatilité 20 séances, RSI 14, ratio de volumes 5/60 séances, pente 20 séances, momentum du BRVM Composite, saisonnalité du mois (rendement moyen historique à 21 séances du mois en cours).
2. **Régression ridge** (`engine/linalg.ts`, résolution par élimination de Gauss) entraînée en marche avant : 70 % des fenêtres les plus anciennes servent à l'apprentissage, 30 % au test. Sur le test, on mesure le **taux de bonne direction** (comparé à la référence « toujours en hausse »), l'**erreur absolue moyenne** et celle d'une prévision nulle. Le modèle est ensuite réajusté sur tout l'historique pour la prévision du jour.
3. **Modèle autorégressif AR(5)** sur les rendements quotidiens, extrapolé sur l'horizon avec atténuation.
4. **Ensemble** : les deux modèles sont pondérés par l'inverse de leur erreur de test ; chacun est **rétréci vers la dérive historique** s'il n'améliore pas nettement l'erreur naïve (ratio ≤ 0,95 → plein, 1,0 → moitié, ≥ 1,025 → quart). L'actualité récente (sentiment pondéré par la crédibilité des sources) décale l'espérance d'au plus une demi-volatilité d'horizon.
5. **Monte-Carlo** : 1 000 trajectoires log-normales (dérive = espérance de l'ensemble, volatilité EWMA λ = 0,94) donnent la probabilité de hausse, les probabilités de mouvements > +5 % et < −5 %, les quantiles 5/25/50/75/95 % et les cours cibles correspondants.
6. **Explications** : la contribution de chaque facteur (β × facteur standardisé, en points de rendement) est renvoyée et les trois plus fortes sont verbalisées, avec la part du modèle AR, l'effet de l'actualité et la précision mesurée.

Le `ForecastService` met les prévisions en cache 15 minutes et les recalcule en tâche de fond ; `/api/market/forecasts` classe les valeurs par rendement attendu × confiance. **La précision affichée est celle du passé de la valeur ; elle ne garantit rien.**

## 9. Optimisation de portefeuille (`server/src/engine/optimizer.ts`)

Le guichet de conseil construit l'allocation par **moyenne-variance sous contraintes** :

- **Rendement attendu** par valeur = dividende + espérance de cours, mélange de la prévision à 3 mois annualisée (pondérée par sa confiance) et de l'objectif de cours de l'analyse technique, borné à ±40 %.
- **Covariance** annualisée des rendements quotidiens (300 séances), rétrécie de 30 % vers la diagonale pour la stabilité.
- **Contraintes** : part investie fixée (1 − réserve de liquidités liée au profil et au sentiment de place), poids maximal par ligne, par secteur, nombre de lignes, secteurs ou valeurs exclus. Si les plafonds rendent l'objectif d'investissement impossible, ils sont relevés et le rapport le signale.
- **Résolution** par gradient projeté : minimisation de la variance avec pénalité quand le rendement cible n'est pas atteint ; projection itérative sur les bornes et la contrainte de somme. Le nombre de lignes est respecté en conservant les plus pondérées puis en ré-optimisant sur ce sous-ensemble.
- **Faisabilité** : le rendement maximal atteignable sous contraintes est calculé ; un objectif supérieur est signalé comme hors de portée et l'allocation vise ce maximum.
- **Frontière efficiente** : six portefeuilles entre variance minimale et rendement maximal, affichés dans le rapport avec le portefeuille retenu.

Le taux sans risque de référence (`RISK_FREE_RATE`, 6 % par défaut, indicatif des obligations d'État UEMOA) sert au ratio de Sharpe. Si moins de deux valeurs sont éligibles, l'allocation heuristique par score (section 3) prend le relais et le rapport l'indique.

## 10. Collecte élargie d'actualité

`NewsService` suit par défaut huit sources : BRVM (actualités, avis et communiqués), RichBourse, Sika Finance (flux RSS et page Marchés), Financial Afrik, Agence Ecofin, Abidjan.net Économie. Trois analyseurs : RSS/Atom, page BRVM, et un **analyseur générique de listes d'articles** (liens internes au titre de 20 à 220 caractères, date et résumé trouvés à proximité). Chaque source a une **crédibilité** (BRVM 100 %, sites boursiers 90 %, presse économique 80 %, généraliste 60 %) qui pondère son sentiment dans les agrégats. L'état de chaque source (dernier passage, articles lus et retenus, erreur) est exposé par `/api/market/news` et affiché dans la page Signaux & agenda. Sources supplémentaires : `NEWS_FEEDS` (RSS) ou `NEWS_SOURCES_JSON` (`[{ "name", "url", "kind": "rss|html-list", "weight" }]`).

## 11. Apprentissage continu (`server/src/services/learning.ts`)

Le modèle de prévision n'est pas figé : il s'améliore à mesure que ses prévisions sont confrontées au marché.

1. **Journal** : chaque prévision émise (une par jour, valeur et horizon) est enregistrée dans `forecast_log` avec son cours de référence, son espérance, sa probabilité de hausse, son intervalle 90 %, la part de chaque modèle et l'ajustement d'actualité.
2. **Résolution** : quand l'horizon est atteint (5, 21 ou 63 séances), le cours réellement constaté donne le rendement réalisé, la direction correcte ou non, l'erreur absolue, le respect de l'intervalle et le score de Brier de la probabilité.
3. **Recalibrage en ligne** (`model_params`, par valeur et horizon, versionné) à chaque résolution :
   - erreurs réalisées de la régression et du modèle AR (moyennes mobiles exponentielles) qui, dès dix prévisions résolues, entrent pour moitié dans la pondération de l'ensemble ;
   - **biais** : EWMA des écarts réalisé − prévu, appliqué amorti de moitié (borné à ±5 points) ;
   - **largeur des intervalles** : si l'intervalle 90 % est tenu moins de 86 % du temps, la volatilité simulée est élargie ; au-delà de 94 %, resserrée ;
   - **poids de l'actualité** : renforcé uniquement lorsque l'ajustement a réduit l'erreur, affaibli sinon.
4. **Régularisation** : la pénalité ridge est rechoisie parmi {1, 5, 20, 60} par validation en marche avant, au plus une fois par semaine et par valeur, dès vingt prévisions résolues.
5. **Amorçage** : au premier démarrage, des prévisions sont rejouées « comme à l'époque » (historique tronqué, sans actualité) toutes les cinq séances sur les 120 dernières (`FORECAST_BACKFILL_SESSIONS`), puis résolues : la boucle dispose immédiatement de prévisions hors échantillon, étiquetées « amorçage » dans le journal.
6. **Cycle** : résolution et recalibrage toutes les six heures (ou à la demande d'un analyste, `POST /api/market/forecasts/learn`). Le cache des prévisions est marqué périmé après chaque recalibrage.

La précision **en conditions réelles** (direction, erreur, couverture, Brier, par horizon et par mois) est exposée par `GET /api/market/forecasts/learning` et affichée séparément de la précision de backtest, avec les références naïves (« toujours en hausse », prévision nulle). Le journal d'une valeur est consultable via `GET /api/market/forecasts/journal/:symbol`.

## 12. Analyse du portefeuille détenu (`server/src/services/holdings.ts`)

L'utilisateur saisit les titres qu'il détient réellement chez sa SGI (symbole, quantité, prix de revient facultatif, liquidités), à la main, par import d'un relevé copié-collé (symbole ou nom de société, séparateurs libres) ou par copie du portefeuille virtuel. L'analyse produit :

- **Valorisation** : valeur, coût, plus ou moins-value latente par ligne et totale, poids, dividendes annuels attendus.
- **Avis Kraken par ligne** : recommandation (ACHAT FORT → ÉVITER), objectif et stop, prévision 1 et 3 mois avec probabilité de hausse, et une **action concrète** (renforcer, conserver, alléger, vendre) avec quantité et montant : vente sur signal négatif, allègement au-delà du plafond de poids du profil (25 %, 30 % pour un profil dynamique) ou sur prévision défavorable, renforcement sur signal favorable si la ligne est sous-pondérée et que les liquidités le permettent.
- **Risque** : volatilité annuelle issue de la covariance réelle des titres, bêta contre le BRVM Composite, perte maximale sur un an du portefeuille aux quantités actuelles, VaR 95 % à un mois, concentration (indice de Herfindahl).
- **Performance** passée des titres pondérée par leur valeur, comparée à l'indice sur chaque période.
- **Portefeuille cible** : allocation optimisée (section 9) avec une prime de détention de 3 points pour les titres déjà en portefeuille (frais et fiscalité d'un aller-retour) ; les transactions pour s'en rapprocher sont listées, les mouvements inférieurs à 3 % du portefeuille ignorés.
- **Actions ordonnées** par priorité (ventes, allègements, renforcements, nouvelles lignes, diversification, liquidités), synthèse et avertissements.

Le portefeuille enregistré peut être transmis d'un clic au guichet de conseil (section 7) pour une proposition relue par un analyste.

## 13. Obligations (`server/src/engine/bonds.ts`, `server/src/services/bonds.ts`)

Le compartiment obligataire de la BRVM (emprunts d'État de l'UEMOA, BOAD, BIDC, CRRH, FCTC Sonatel, obligations d'entreprises, sukuk) est intégré à l'analyse et au conseil.

- **Référentiel** (table `bonds`) : amorcé depuis un instantané du tableau officiel « Cours des obligations » du site de la BRVM (`data/bonds.ts`, 45 lignes au 21 octobre 2026), tenu à jour par **collecte automatique** sur brvm.org toutes les 30 minutes (`BOND_SOURCES`, pagination tentée) ou par **collage du tableau** par un administrateur (`POST /api/market/bonds/import-cote`, page Obligations). Le libellé officiel donne l'émetteur (table de préfixes : TPCI, EOS, TPBF, TPNE, BOAD, BIDC, CRRH, FSNTS, ORGT, PADS, PTRC…), le taux et les années ; les dates de jouissance et le mode d'amortissement, absents de la cote, sont **estimés** (`dates_estimated`) jusqu'à ce qu'un administrateur les précise (`POST /api/market/bonds`). Les lignes échues sans cours sont désactivées ; l'ancien référentiel fictif est désactivé à la migration.
- **Cours** : la BRVM cote les obligations en **pourcentage du nominal restant dû** ; la plateforme conserve ce cours (`quoted_pct`, veille, volume, suspension) et en déduit le prix pied de coupon en FCFA. Sans cours officiel récent (10 jours), un cours indicatif est simulé (rendement autour de coupon + écart d'émetteur, retour à la moyenne). Un administrateur peut saisir un cours en % (`PUT /api/market/bonds/:code/price`). L'historique de 260 séances sert à la covariance des portefeuilles.
- **Calculs** : échéancier complet (coupons sur capital restant dû, remboursements in fine, constants ou par annuités, différé), coupon couru, prix ↔ rendement actuariel (bissection, composition annuelle, base ACT/365), duration de Macaulay et modifiée, convexité, sensibilité à 1 point de base, rendement courant. Un cours officiel très au-dessus du pair peut donner un rendement faible ou négatif : il est affiché tel quel.
- **Part obligataire cible** selon le profil : 55 % (très prudent), 45 %, 30 %, 15 %, 5 % (offensif) ; +10 points pour un objectif de revenus, −5 pour la croissance, −10 pour la spéculation ; +10 si l'horizon est inférieur à deux ans, −5 au-delà de huit ans ; bornée à 70 %.
- **Sélection** : échéances entre un an et horizon + 3 ans, lignes non suspendues, cotées BRVM de préférence, classement par rendement actuariel corrigé du risque émetteur (pénalité sur les entreprises, plus forte pour les profils prudents) et de l'exonération fiscale, au plus 40 % par émetteur, jusqu'à quatre lignes.
- **Conseil** (section 7) : la poche obligataire est constituée avant l'optimisation des actions ; la réserve de liquidités est ramenée à 10–15 % lorsque la poche obligataire assure la fonction défensive ; le rapport donne les lignes (cours en %, quantité, montant), le rendement moyen, la duration, les coupons annuels et des scénarios où la poche obligataire ne varie que de ± duration × 1 point de taux.
- **Portefeuille détenu** (section 12) : lignes obligataires valorisées coupon couru inclus (prix de revient saisi en % du nominal ou en FCFA), rendement actuariel, duration, échéance, prochain coupon, action (conserver jusqu'à l'échéance, alléger si le rendement est nettement sous le taux de référence, échéance proche) ; répartition actions / obligations / liquidités ; calendrier des coupons et remboursements à douze mois ; comparaison de la poche obligataire à la cible du profil avec suggestions ; concentration par émetteur ; les obligations entrent dans la covariance, le bêta, la perte maximale et la VaR.
