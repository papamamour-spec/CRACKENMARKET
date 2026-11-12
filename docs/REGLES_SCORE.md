# Score de qualité et de risque d'un titre

Chaque action cotée reçoit un score de 0 à 100 et un verdict : **SOLIDE** (80 et plus), **CORRECT** (60 à 79), **FRAGILE** (40 à 59), **RISQUÉ** (moins de 40). Les règles ci-dessous sont celles du code (`server/src/engine/quality.ts`, `QUALITY_RULES`, version 1.0) et sont exposées par `GET /api/market/quality/rules`. Ce n'est pas une boîte noire : chaque partie, chaque seuil et chaque drapeau est écrit ici.

## Cinq parties

Chaque partie obtient tous ses points au seuil « plein », zéro au seuil « nul », et varie linéairement entre les deux.

| Partie | Points | Plein | Nul | Ce qui est mesuré |
|---|---:|---|---|---|
| Liquidité | 25 | ≤ 5 séances | ≥ 60 séances | Nombre de séances pour céder une position de 10 M FCFA en absorbant 20 % des capitaux moyens échangés sur 60 séances |
| Stabilité des cours | 20 | volatilité ≤ 20 %, repli max ≤ 15 % | volatilité ≥ 60 %, repli max ≥ 50 % | Moyenne de la note de volatilité annualisée (60 séances) et de la note de perte maximale sur un an |
| Transparence | 20 | rapport annuel du dernier exercice attendu publié, résultats de moins de 7 mois | rapport annuel en retard de deux exercices, résultats de plus de 13 mois | Publications collectées (rapports annuels, états financiers, résultats). Exercice attendu : N−1 à partir de mai, N−2 avant |
| Structure de l'actionnariat | 20 | flottant ≥ 30 %, actionnaire principal ≤ 50 % | flottant ≤ 10 %, actionnaire principal ≥ 85 % | Profil renseigné par un analyste (flottant, actionnaire principal, part de l'État) |
| Rendement et dividende | 15 | rendement ≥ max(4 %, médiane du secteur) et 5 ans de dividendes | aucun dividende | 70 % rendement relatif au secteur, 30 % régularité (années consécutives) quand elle est renseignée |

## Données absentes : « non vérifié »

Une partie dont les données manquent (aucune publication collectée, profil d'actionnariat non renseigné) n'est **pas** notée : elle est marquée « non vérifiée », retirée du barème, et la **confiance** du score est la part du barème effectivement vérifiée (par exemple 60 % si transparence et actionnariat manquent). Le score est alors calculé sur les parties vérifiées seulement. Une donnée absente n'est jamais comptée comme bonne.

## Drapeaux rouges : RISQUÉ quel que soit le score

- Cotation suspendue (profil) ou suspension mentionnée dans l'actualité des 30 derniers jours.
- Rapport annuel de l'exercice précédent toujours absent après le 31 octobre.
- Flottant inférieur à 10 %.
- Aucun échange sur les 20 dernières séances.

## Plafonds : FRAGILE au mieux (59)

- Plus de 30 séances pour céder 10 M FCFA.
- 10 séances ou plus sans échange sur les 20 dernières.
- Actionnaire principal à 85 % ou plus.
- Taux de distribution supérieur à 100 % (le dividende dépasse le résultat).
- Actualité fortement défavorable : sentiment ≤ −0,5 sur au moins 3 articles.
- Profil vérifié à moins de 60 % du barème.

## Ce que le score ne dit pas

Il mesure la qualité d'un titre comme instrument (liquidité, stabilité, information, actionnariat, rendement), pas son potentiel de hausse : c'est le rôle des recommandations et des prévisions. Un titre SOLIDE peut baisser ; un titre FRAGILE peut être une opportunité pour un investisseur averti. Les mesures de marché viennent des cotations (réelles en production, simulées en développement) ; les publications viennent de la collecte de documents ; l'actionnariat vient des profils saisis par les analystes.
