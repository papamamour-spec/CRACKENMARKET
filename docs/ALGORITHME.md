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

## 14. Documents des sociétés (`server/src/services/documents.ts`)

L'historique des publications des sociétés cotées (rapports annuels, états financiers, communiqués de résultats, avis de dividende, convocations d'assemblée, notes d'information) est collecté et conservé en base (`company_documents`, dédoublonnée par URL).

- **Sources** par défaut : RichBourse (page « rapports d'activité et états financiers » et page société par valeur), BRVM (rapports annuels, communiqués des sociétés) ; complétées par `DOC_SOURCES_JSON` (`[{ "name", "url", "perCompany" }]`, `{symbol}` et `{name}` substitués pour les sources société par société). Collecte au démarrage puis toutes les six heures, pagination « ?page=n » tentée jusqu'à une page sans document nouveau ; collecte manuelle et import par collage (`SYMBOLE ; titre ; lien ; date`) pour les analystes.
- **Extraction générique** : liens vers des fichiers (PDF, Word, Excel) ou des pages de document, titre du lien ou du bloc parent (quand le lien dit « Télécharger »), date trouvée à proximité (ISO, JJ/MM/AAAA, « 12 mars 2026 », balise `time`), société déduite du titre par le dictionnaire d'alias de la veille ou imposée par la page société.
- **Classement** par type d'après le titre (rapport annuel, états financiers, résultats, dividende, assemblée, note d'information, communiqué) et **période** (année, semestre, trimestre, neuf mois).
- **Exploitation** : historique par société groupé par année avec dernier rapport annuel et derniers résultats (`GET /api/market/documents/history/:symbol`), liste filtrable (`GET /api/market/documents`), état des sources ; les résultats, dividendes et communiqués sont aussi injectés dans la veille d'actualité (section 7) et pèsent donc, via leur sentiment, sur les recommandations.

## 15. Score de qualité et de risque, profils d'émetteurs, radar

- **Score de qualité** (`server/src/engine/quality.ts`, règles publiées dans `docs/REGLES_SCORE.md` et par `GET /api/market/quality/rules`) : cinq parties notées linéairement entre un seuil plein et un seuil nul (liquidité 25, stabilité des cours 20, transparence 20, structure de l'actionnariat 20, rendement et dividende 15), drapeaux rouges forçant le verdict RISQUÉ (suspension, rapport annuel absent après le 31 octobre, flottant < 10 %, aucun échange sur 20 séances), plafonds limitant à FRAGILE (liquidité > 30 séances, 10 séances sans échange, actionnaire principal ≥ 85 %, distribution > 100 %, actualité fortement défavorable, profil vérifié à moins de 60 %). Une donnée absente rend la partie « non vérifiée » : elle sort du barème et la confiance affichée est la part du barème vérifiée.
- **Profils d'émetteurs** (`company_profiles`) : flottant, actionnaire principal, part de l'État, actions, taux de distribution, années de dividende, suspension, note de source ; renseignés par les analystes depuis la fiche valeur (`PUT /api/market/profile/:symbol`). La transparence est lue dans les documents collectés (section 14), l'actualité dans la veille (section 7). Le score apparaît sur la fiche valeur, dans le screener et sur chaque ligne du portefeuille détenu, où un titre RISQUÉ déclenche un avertissement.
- **Radar de la place** (`server/src/services/radar.ts`, table `radar_events`) : introductions en bourse, émissions obligataires, offres publiques, augmentations de capital, dividendes, résultats, assemblées, suspensions, nouvelles obligations cotées et échéances du calendrier à 30 jours, détectés par mots-clés dans l'actualité et les documents collectés, dans la cote obligataire et le calendrier, dédoublonnés par type, société et titre, balayés toutes les 30 minutes et à chaque collecte. Page Radar avec filtre par type, nouveautés de 48 heures et échéances à venir.

## 16. Données officielles : historique ajusté, dividendes réels, bulletin de la cote

- **Historique ajusté** (`server/src/engine/corporate.ts`) : toute série lue par les modèles (prévision, apprentissage continu, optimiseur, indicateurs techniques, analyse du portefeuille détenu) est ajustée des opérations sur le capital connues. En remontant le temps, chaque clôture antérieure à une opération est ramenée dans l'unité de la clôture actuelle : fractionnement 1 → k (cours ÷ k, volumes × k), regroupement k → 1 (cours × k), attribution gratuite 1 pour k (cours × k / (k + 1)), détachement d'un dividende D (cours × (1 − D / C), C clôture de la veille, méthode « rendement total »). Les facteurs se cumulent ; le dernier cours ajusté est toujours le cours réel. Les graphiques affichent les cours réellement cotés, avec une bascule « Cours ajustés » (`GET /api/market/history/:symbol?adjusted=1`, étapes d'ajustement renvoyées). Le réalisé de l'apprentissage continu est calculé sur la série ajustée (clôture de la séance de prévision → clôture à l'horizon) : c'est un rendement total, cohérent avec le rendement attendu.
- **Fractionnements suspectés** : la BRVM réservant un titre dès ±7,5 %, un rapport de clôtures proche d'un entier k ≥ 2 confirmé les séances suivantes ne peut venir que d'une opération. `detectSplits` les propose comme « suspectés » ; rien n'ajuste les séries avant confirmation par un analyste (`POST /api/market/corporate/actions/detect`, `/actions/:id/confirm`).
- **Dividendes réels** (`server/src/services/corporate.ts`, tables `corporate_actions` et `dividends`) : brut, net (sinon brut après retenue à la source de 10 %), exercice, dates de détachement, de paiement et d'assemblée, statut (proposé → approuvé → payé), source. Saisie et import par les analystes (`POST /api/market/corporate/dividends`, `/dividends/import`), lecture automatique des avis dans l'actualité et les documents collectés (`parseDividendNotice` : montants, dates, statut d'après le vocabulaire ; une source automatique complète les champs vides sans écraser une saisie et ne fait jamais régresser un statut). Effets : rendement net réel dans le score de qualité et le conseiller (sinon le référentiel), calendrier aux dates publiées (remplace les dates indicatives, nourrit le radar), objectifs de cours des prévisions diminués d'un détachement attendu dans l'horizon (le rendement total attendu reste celui de l'ensemble, l'explication le dit).
- **Bulletin officiel de la cote** (`server/src/data/boc.ts`, `server/src/services/boc.ts`, table `daily_stats`) : par séance et par valeur, cours de référence, ouverture, clôture, variation, volume, capitaux, nombre de transactions, meilleures demande et offre (prix et quantités), réservation à la hausse ou à la baisse, suspension. Lecture d'un texte à blancs (extraction PDF par pdfjs, fragments regroupés par ligne et séparés en colonnes par l'écart horizontal) ou d'un tableau à séparateurs ; les colonnes sont reconnues dans l'en-tête, à défaut configurées (`BOC_COLUMNS`) ou prises dans l'ordre de la page des cours BRVM. Collecte horaire sur les modèles d'URL de `BOC_SOURCES` (jetons de date `{YYYYMMDD}`, `{DD-MM-YYYY}`, `{YYYY}`, `{MM}`, `{DD}`), pour les dernières séances closes manquantes ; import collé par l'administrateur. La clôture officielle remplace la bougie construite à partir des cotations relevées ; les meilleures limites s'affichent à côté du carnet reconstitué.
- **Facteurs de prévision** : deux facteurs s'ajoutent à la régression (section 8) dès qu'un bulletin existe, nuls sinon : déséquilibre des meilleures limites de la dernière séance connue (valeur demandée − valeur offerte, rapportée au total, de −1 à +1) et solde des réservations sur 5 séances (+1 hausse, −1 baisse). Leur poids est appris comme celui des autres facteurs et apparaît dans les contributions.

## 17. Évaluation en marche avant (`server/src/engine/evaluation.ts`, `server/src/services/evaluation.ts`)

- **Principe** : à chaque date d'évaluation (toutes les `step` séances sur les `sessions` dernières), chaque valeur est prévue avec son seul historique antérieur (paramètres par défaut, graine fixe, aucune donnée postérieure), puis confrontée au rendement réalisé à chaque horizon sur la série ajustée (section 16), donc en rendement total. Même base, même configuration et même graine donnent le même rapport : les versions du modèle se comparent entre elles (`GET /api/market/evaluation/history`).
- **Mesures par horizon** : taux de bonne direction contre la référence « toujours en hausse » ; erreur absolue contre la prévision nulle et gain = 1 − erreur / erreur naïve ; **corrélation de rang** (Spearman) entre prévu et réalisé à chaque date (au moins 5 valeurs), moyenne, écart-type, statistique t et part des dates positives, car l'optimisation ne demande au modèle que de classer ; **calibration** : couverture réelle de l'intervalle à 90 % (cible 85 à 95 %), score de Brier de la probabilité de hausse contre celui d'une probabilité constante, table de fiabilité par tranche de probabilité annoncée ; **stratégie** « k meilleures prévues », équipondérée, rebalancée toutes les ⌈h / pas⌉ × pas séances (position tenue h séances puis liquidités), nette de frais de courtage (`feePct` par ordre, défaut 1,25 %, payés sur la seule part du panier renouvelée), contre le panier équipondéré et l'indice composite : total, annualisé, perte maximale, Sharpe, part de périodes gagnantes, courbes.
- **Exécution** : en tâche de fond par dates (`POST /api/market/evaluation/run`, analystes ; progression dans `GET /api/market/evaluation`), rapports conservés (`evaluation_reports`) ; en ligne de commande `npm run evaluate -w server -- --sessions 400 --step 10 --topk 5 --fee 1.25 --out rapport.json` (tableau Markdown sur la sortie standard).
- **Apprentissage continu** : la corrélation de rang par jour de prévision est aussi calculée sur le journal des prévisions résolues (`rankIC` par horizon dans `GET /api/market/forecasts/learning`), pour suivre en conditions réelles la capacité du modèle à classer les valeurs.
- **Lecture honnête** : ce sont des mesures passées ; sur l'historique simulé elles ne décrivent pas le marché réel. Une amélioration du modèle n'en est une que si elle élève la corrélation de rang et le gain d'erreur sans dégrader la calibration.

## 18. Fondamentaux structurés (`server/src/engine/fundamentals.ts`, `server/src/services/fundamentals.ts`)

- **Lecture des publications** : chiffre d'affaires (ou produit net bancaire), résultat net, capitaux propres, bénéfice et dividende par action, variations annoncées, période (exercice, semestre, trimestre) et date de publication, lus dans les titres et résumés des documents et de l'actualité collectés, et dans le corps des documents (PDF ou HTML) à la demande. Montants en FCFA avec unités (milliards, millions). Un champ absent reste vide ; une lecture automatique (statut « auto ») complète sans jamais remplacer une saisie d'analyste.
- **Saisie et import** (table `fundamentals`, une ligne par société et période) : `POST /api/market/fundamentals`, `/import`, `/scan` (avec `fetch` pour télécharger les documents), `DELETE`. Nombre d'actions pris dans l'enregistrement, sinon dans le profil d'émetteur.
- **Ratios** (`valuationMetrics`) : BPA, actif net par action, PER, cours / actif net, rendement bénéficiaire (1 / PER), ROE, croissance du chiffre d'affaires et du résultat (exercice sur exercice, sinon variation annoncée), distribution, marge nette ; champs manquants nommés. Affichés sur la fiche valeur et dans « Données officielles ».
- **Sans fuite du futur** : `earningsYieldAt(symbol, date, cours)` ne retient que les exercices publiés avant la date (date de publication, sinon fin de période + 120 jours) ; c'est cette version datée qui nourrit le modèle de panel et l'évaluation.

## 19. Modèle de panel (`server/src/engine/panel.ts`, `server/src/services/panel.ts`)

- **Principe** : une régression ridge commune à toute la cote, entraînée sur une observation toutes les deux séances pour chaque valeur (environ cinquante fois plus de données qu'un modèle par valeur), dont la cible est le **rendement relatif** à l'horizon (rendement de la valeur moins la moyenne des valeurs à la même date). Facteurs : momentum 1 et 3 mois, écart à la moyenne 50 séances, volatilité 20 séances, RSI, volumes, pente, rangs transversaux du momentum et de la volatilité sur la cote, rendement du dividende connu à la date, rendement bénéficiaire connu à la date, détachement de dividende sous 30 jours. Test chronologique sur les 30 % de dates les plus récentes (erreur contre la prévision nulle, direction relative), puis réajustement sur tout l'historique pour prédire la dernière date.
- **Dans l'ensemble** (section 8) : troisième modèle à côté de la régression par valeur et de l'autorégressif ; sa prévision absolue = dérive propre de la valeur + rendement relatif (rétréci si le modèle ne bat pas la prévision nulle en test), pondérée par l'inverse de son erreur de test puis, en conditions réelles, de son erreur réalisée (`modelErr.panel`, colonne `panel_pct` du journal). Contributions des facteurs et explication en français ; `GET /api/market/panel` expose les statistiques et le classement des rendements relatifs.
- **Mesuré par le backtest** (section 17) : à chaque date d'évaluation, le panel est réentraîné sur les seules données antérieures (`panelAt`) avec les variables de fondamentaux datées ; l'option `panel` de l'évaluation permet de comparer les rapports avec et sans.

## 20. Black-Litterman (`server/src/engine/blacklitterman.ts`)

- **Problème** : des rendements attendus bruités donnent des allocations moyenne-variance extrêmes. **Réponse** : partir de l'équilibre du marché, Π = rf + δ Σ w (w pondérations par capitalisation, actions en circulation × cours, sinon le proxy de flottant de l'indice ; δ aversion au risque calée sur une prime de 4 % et la variance du marché, entre 1 et 6), et n'en dévier qu'en proportion de la confiance de chaque vue : μ = Π + τΣ (τΣ + Ω)⁻¹ (Q − Π) avec P = I, Ω_ii = τ Σ_ii (1 − c_i) / c_i, τ = 0,05, c_i = 0,2 + 0,6 × confiance de la prévision à 3 mois (0,3 sans prévision).
- **Intégration** : par défaut dans le guichet de conseil (`returnModel: "black_litterman"`, ou `"views"` pour les prévisions brutes) et dans l'allocation cible du portefeuille détenu ; les valeurs sans historique suffisant gardent leur vue. Le rapport détaille par valeur poids de marché, rendement d'équilibre, vue, confiance, rendement retenu et part de la vue.

## 21. Collecte automatique validée sur les sites réels

Les collecteurs ont été vérifiés sur les pages réelles de brvm.org et de sikafinance.com (novembre 2026) ; leurs formats sont figés dans des fixtures de test (`server/test/fixtures/`). Toutes les requêtes passent par `services/fetchPolicy.ts` : délai de 10 s entre deux requêtes vers brvm.org (robots.txt), 2 s vers Sika Finance, documents `/docs/` de Sika jamais téléchargés (robots.txt), RichBourse jamais sollicité (le site refuse l'extraction automatique ; ses exports CSV s'importent à la main dans « Données officielles »).

- **Cote en direct** (`data/providers/live.ts`) : tableau des cours de brvm.org (symbole, nom, volume, veille, ouverture, clôture, variation), secours sur la liste de A à Z de Sika Finance (symbole lu dans le lien de chaque ligne).
- **Bulletin officiel** (`data/brvmBulletin.ts`, `services/boc.ts`) : les PDF quotidiens `boc_AAAAMMJJ_n.pdf` sont découverts sur la page des bulletins (variante corrigée privilégiée), lus par pdfjs puis par le lecteur du format réel : en-tête (séance, indices), marché des actions (cours précédent, ouverture, clôture, variation, volume, valeur, référence, variation de l'année, dernier dividende net et sa date, rendement net, PER, mentions SP et NC, secteur, compartiment), obligations (nominal, cours, coupon couru, périodicité, coupon net, prochaine échéance, amortissement), carnets des actions et des obligations (meilleures limites), opérations en cours, avis et communiqués. Application : `daily_stats` (avec PER, rendement, dernier dividende, variation annuelle), bougie officielle, meilleures limites du carnet, cours des obligations en % du nominal (`BondService`), dividendes (exercice = année de paiement − 1, source automatique), avis et communiqués dans la veille (et donc le radar). Une collecte par heure, jusqu'à cinq séances manquantes par passage ; `BOC_AUTO=0` la désactive, `BOC_SOURCES` ajoute des sources au format générique.
- **Historique réel des cours** (`data/sika.ts`, `services/history.ts`) : page « historiques » de chaque valeur sur Sika Finance (environ trois mois d'ouverture, haut, bas, clôture, volumes), lue chaque jour ouvré après la clôture. `MarketService.importRealCandles` remplace les bougies de ces dates (source `sika`, une bougie officielle du bulletin n'est jamais remplacée), supprime le synthétique postérieur à la première séance réelle et recale le synthétique antérieur (facteur unique) pour qu'il se raccorde sans rupture ; la colonne `candles.source` et `historyStatus` disent depuis quand chaque valeur est réelle. Une fois par semaine, la fiche de chaque valeur donne sa capitalisation, d'où le nombre d'actions du profil d'émetteur s'il n'est pas saisi (poids d'équilibre de Black-Litterman). `HISTORY_COLLECT=0` désactive.
- **Dividendes** (`CorporateService.refreshFromSika`) : page des dividendes de Sika Finance, historique par exercice (montants nets) et détachements à venir ; complète sans écraser les saisies.
- **Fondamentaux automatiques** : le corps des publications collectées (PDF ou HTML) est téléchargé en tâche de fond au démarrage, à chaque nouvelle collecte de documents puis toutes les six heures, au plus 60 documents par passage, dans le respect des délais des sites, et analysé par le lecteur de communiqués (section 18) ; les documents déjà lus sont mémorisés (`meta.fundamentals_fetched`). `FUNDAMENTALS_FETCH=0` limite la lecture aux titres.
- **Documents** (`services/documents.ts`, `data/brvmSite.ts`) : index paginé des rapports des sociétés cotées de brvm.org → page de chaque société connue (table `BRVM_COMPANY_SLUGS`) → PDF datés (titre lisible) ; annonces des émetteurs (convocations aux assemblées, communiqués, changements de dirigeants, franchissements de seuil) ; communiqués des sociétés relayés par Sika Finance (titres et dates). Les fondamentaux sont ensuite lus dans ces documents (section 18), avec le PER du bulletin en repli pour le rendement bénéficiaire daté.
- **Actualité** : mediacentre de la BRVM, actualités du marché et communiqués de Sika Finance, formats dédiés.
- **État** : `GET /api/market/collectors` et l'onglet « Collecte » de « Données officielles » montrent chaque flux, son dernier passage et ses échecs ; `GET /api/market/history-status` la part réelle de l'historique par valeur.
- **Référentiel** (`data/instruments.ts`) : 48 valeurs (ajout de BBGC et BICB), cours de référence, volumes et rendements de la cote du 11 novembre 2026.

## 22. Allocations robustes : risque factoriel, perte, liquidité, coûts, rééquilibrage, résistance

- **Modèle de risque factoriel** (`engine/riskmodel.ts`) : chaque valeur est décrite par son exposition au marché (rendements de l'indice composite), à la taille (petites moins grandes capitalisations), au rendement (fort moins faible rendement du dividende) et à son secteur (moyenne du secteur moins le marché, secteurs d'au moins deux valeurs), estimée par régression ridge sur l'historique ajusté ; Σ = B Φ B' + D. La covariance de l'optimiseur et de Black-Litterman mélange cette structure et l'échantillon rétréci (50/50). Le rapport donne le nombre de facteurs, le R² moyen et le nombre de séances ; sans historique suffisant (moins de quatre valeurs ou 60 séances), l'échantillon seul est utilisé et signalé.
- **Limite de perte** : CVaR historique à 95 % sur un mois (perte moyenne des 5 % de pires fenêtres de 21 séances de la combinaison), VaR et perte maximale. Limite selon la tolérance 1…5 : 6, 9, 12, 16, 22 %. Si l'allocation la dépasse, l'optimiseur la combine avec le portefeuille de variance minimale (bissection) jusqu'à la respecter, et le signale ; si même la variance minimale la dépasse, il le dit et propose de réduire la part investie.
- **Liquidité** (`engine/costs.ts`) : une ligne doit pouvoir être soldée en 10 séances sans dépasser 25 % des capitaux échangés chaque jour (volume moyen × cours) ; d'où un plafond de poids par valeur fonction du capital, combiné au poids maximal du profil. Si les plafonds ne permettent pas d'investir la part prévue, elle est ramenée et expliquée. Le délai de sortie de chaque ligne est affiché ; au-delà de 10 séances, avertissement.
- **Coûts** : grille indicative d'un ordre BRVM (commission SGI 0,8 % + TVA 18 %, redevance BRVM 0,1 %, DC/BR 0,05 %, minimum 2 500 FCFA ; `FEES_JSON` la surcharge). L'optimiseur retire du rendement cible le coût d'un sens × Σ|w − w₀| amorti sur l'horizon : il ne s'éloigne du portefeuille existant que si le gain le justifie ; le rapport donne rendement brut et net, frais d'entrée, aller-retour, rotation. Retenue à la source sur les dividendes par pays de l'émetteur (indicative : CI 10 %, SN 10 %, BF 6 %, ML 10 %, NE 10 %, BJ 7 %, TG 7 % ; `DIVIDEND_TAX_JSON`) ; les rendements lus dans le bulletin officiel sont déjà nets.
- **Rééquilibrage par bandes** (`engine/rebalance.ts`) : pour le portefeuille détenu, on n'agit que sur les lignes sorties de ± max(3 points, 25 % du poids cible) autour de la cible, opérations d'au moins 50 000 FCFA, frais estimés par ordre, revue périodique trimestrielle (prochaine date affichée) ; les lignes dans leur bande sont listées sans opération.
- **Tests de résistance** (`engine/stress.ts`) : pire fenêtre de trois mois de l'indice dans l'historique disponible (2020 dès que l'historique réel le couvre) et meilleur rallye, rejoués valeur par valeur (bêta × indice sans historique) ; krach de place −20 % × bêta ; choc −15 % sur le premier secteur ; suspension du dividende de la première ligne ; taux +100, +200, −100 pb sur la poche obligataire (duration et convexité). Résultat par scénario en % et en FCFA, lignes les plus touchées.
- **Suivi réel des recommandations** (`services/tracking.ts`, table `recommended_portfolios`) : un conseil ou une cible « suivi » est figé à sa date (quantités au cours du jour, frais d'entrée déduits) et valorisé chaque séance sur les cours ajustés (dividendes et opérations inclus), net des frais de sortie, contre le BRVM Composite et le BRVM 30 : performance nette, écart, annualisé, perte maximale, volatilité, part des séances gagnantes. Page Performance ; routes `GET/POST /api/tracking`, `GET/DELETE /api/tracking/:id`.

### Rendement durable du dividende

Le rendement retenu par le conseiller, le score de qualité et les modèles n'est plus le dernier dividende rapporté au cours, mais la **médiane des dividendes nets des trois derniers exercices payés** ; sans historique, un rendement au-delà de 15 % est plafonné. Un dividende exceptionnel (Filtisac 2026 : ≈ 1 727 FCFA net pour un cours de 1 700, soit 102 % au bulletin) est signalé (`exceptional`) et n'est pas extrapolé dans les rendements attendus.

## 23. Portefeuilles modèles par profil (`server/src/services/models.ts`)

Quatre portefeuilles de référence tenus comme une gestion modèle, à la manière des portefeuilles modèles des grands gestionnaires :

| Modèle | Objectif | Horizon | Tolérance | Lignes max. | Poids max. |
| --- | --- | --- | --- | --- | --- |
| Prudent | équilibré | 36 mois | 2 | 8 | 20 % |
| Équilibré | équilibré | 48 mois | 3 | 8 | 25 % |
| Dynamique | croissance | 60 mois | 4 | 7 | 25 % |
| Revenus | revenus | 60 mois | 3 | 8 | 20 % |

- **Calcul** : le guichet de conseil (section 7) sur un capital nominal de 10 M FCFA, avec Black-Litterman, covariance factorielle, limite de perte, plafonds de liquidité, coûts et poche obligataire (sections 9, 13, 20, 22). La version retient les lignes actions (poids du capital), les obligations, la réserve de liquidités, les métriques (rendement brut et net, volatilité, Sharpe, dividende, CVaR et limite, modèle de risque), la lecture du moteur et quatre scénarios de résistance.
- **Proposition et publication** : le moteur calcule une proposition deux minutes après le démarrage puis chaque jour ouvré après la clôture (`MODELS_AUTO=0` désactive). Un modèle jamais publié l'est automatiquement (statut « auto ») ; ensuite seul l'analyste publie, avec une note : la proposition devient la version de référence (numéro de version incrémenté, historique dans `model_versions`). La **dérive** entre version publiée et proposition est donnée en opérations hors bande (section 22) et en écart de rendement net.
- **Suivi** : chaque publication crée un portefeuille suivi (section 22, type « modèle ») : performance nette de frais contre BRVM Composite et BRVM 30 depuis la publication, par version.
- **Plan pour mon portefeuille** : rapprochement du portefeuille détenu (section 12) d'un modèle par bandes de non-échange sur les actions (opérations, frais, rotation, prochaine revue), écart de la poche obligataire et liquidités.
- Routes : `GET /api/models`, `GET /api/models/:key` (versions, série), `GET /api/models/:key/plan`, `POST /api/models/recompute` et `POST /api/models/:key/publish` (analyste). Page « Portefeuilles modèles ».

## 24. Contrôle de qualité des données et rapport de risque du jour (`server/src/services/dataquality.ts`)

Chaque jour ouvré après la clôture (3 minutes après le démarrage, puis après 16 h UTC ; `QUALITY_AUTO=0` désactive) et à la demande, dix contrôles passent sur les données qui nourrissent les modèles :

| Contrôle | Ce qui est vérifié | Sévérité |
| --- | --- | --- |
| Cohérence bulletin / cours en base | clôture du bulletin officiel contre la bougie de la même séance | écart > 1 % avertissement, > 5 % erreur, séance absente |
| Fraîcheur du bulletin | séances manquantes depuis la dernière séance close, couverture, dernier passage | 1–2 séances avertissement, ≥ 3 erreur |
| Fraîcheur de l'historique réel | dernière séance réelle par valeur, valeurs sans séance réelle, collecte en échec | ≥ 5 séances de retard avertissement |
| Variations hors limite | variations > 7,5 % entre deux séances réelles (limite BRVM), clôtures invalides | avertissement / erreur |
| Dividendes | dividende exceptionnel (section 23), écart entre dividende enregistré et dernier dividende du bulletin, dividende du bulletin non enregistré | avertissement / information |
| Référentiel | cours de référence éloigné de plus de 50 % du cours, valeurs sans nombre d'actions | avertissement / information |
| Fondamentaux | sociétés sans publication, résultat net > chiffre d'affaires, capitaux propres négatifs, publications de plus de 18 mois | avertissement / information |
| Obligations | lignes actives sans cours récent, rendement actuariel hors de [0 ; 25 %] | avertissement / information |
| Collecteurs | sources injoignables, documents en échec, publications illisibles, retour en simulation, collecte des obligations | erreur / avertissement / information |
| Modèles | modèle non publié, CVaR au-dessus de la limite, dérive de la proposition | avertissement / information |

Score = 100 − 10 par erreur − 3 par avertissement − 0,5 par information (borné à 0). Chaque constat porte une empreinte stable : le passage suivant liste les constats **nouveaux** et **résolus**. Les passages sont conservés (`data_quality_runs`) ; une nouvelle erreur ou une baisse du score de plus de 10 points envoie une alerte aux administrateurs et analystes connectés.

**Rapport du jour** (`daily_reports`) : place (indices, hausses et baisses), score de qualité, portefeuille détenu du propriétaire (valeur, séance, CVaR et limite, volatilité, bêta, pire scénario de résistance, lignes hors bande, prochaine revue, avertissements), modèles (performance nette, écart à l'indice, CVaR, dérive). Les **changements depuis la veille** sont listés : baisse du score, nouvelles erreurs, CVaR franchissant la limite ou variant de 2 points, lignes sortant de leur bande, séance de ± 2 %, dérive d'un modèle, nouvelle version publiée, indice de ± 1,5 %. Page « Qualité & risque du jour » ; routes `GET /api/quality`, `POST /api/quality/run`, `GET /api/quality/daily`, `POST /api/quality/daily/run` (analyste).

## 25. Attribution de performance (`server/src/engine/attribution.ts`, `server/src/services/attribution.ts`)

D'où vient la performance d'un portefeuille suivi (conseil, cible, modèle, depuis son départ) ou du portefeuille détenu (1 mois à 1 an, quantités actuelles tenues constantes) ? Méthode de **Brinson-Fachler** sur la période, en achat-conservation, contre le BRVM Composite reconstitué avec les pondérations de la plateforme (cours × volume moyen) :

- **Contribution** de chaque ligne = poids de départ × rendement total (série ajustée) ; la somme est le rendement de la poche investie. La part des **dividendes** est l'écart entre série ajustée et série cotée.
- **Allocation sectorielle** (w_p,s − w_b,s)(R_b,s − R_b), **sélection de titres** w_b,s(R_p,s − R_b,s), **interaction** (w_p,s − w_b,s)(R_p,s − R_b,s) ; **liquidités** −(1 − w_investi) × R_b ; la somme est exactement l'écart à l'indice (le résidu affiché provient des arrondis). **Coûts** : frais d'entrée et de sortie des portefeuilles suivis.
- **Marché et spécifique** : bêta du portefeuille contre l'indice sur la période ; contribution du marché = bêta × R_b, le reste est propre au portefeuille.

Routes `GET /api/attribution/holdings?period=1M|3M|6M|YTD|1Y`, `GET /api/attribution/tracking/:id`, `GET /api/attribution/models/:key`. Panneau « D'où vient la performance » sur Performance (portefeuilles suivis), Portefeuilles modèles et Analyser mon portefeuille.
