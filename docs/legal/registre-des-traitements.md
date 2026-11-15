# Registre des traitements

Le registre des traitements (la liste des traitements de données que l'entreprise doit tenir et
pouvoir présenter à la CNIL) est exigé par l'article 30 du RGPD. Ce fichier en tient la version
courante pour AshuWorld.

Le service ne réalise qu'une opération de traitement : un compte Dachi, son XP, son niveau, son
apparition dans le classement public et la sécurité qui va avec. Tout ce que le code écrit
appartient à cette opération ; il n'y a pas de second registre à tenir.

## Le traitement

| Champ attendu par l'article 30 | Contenu |
|---|---|
| Nom du traitement | Comptes Dachi, XP et classement public |
| Responsable du traitement | ASHU DEV, SARL au capital de 1 000 €, SIREN 898 442 538, RCS Paris 898 442 538, siège social 14 rue Bausset, 75015 Paris, France. Contact : info@ashudev.com. Représentant légal : Valentin Ronteix. |
| Finalités | 1. Tenir un compte Dachi et les identités de plateforme qui y sont rattachées. 2. Calculer et afficher l'XP et le niveau. 3. Publier le classement public. 4. Sécuriser le service et empêcher la double attribution (qu'une même action vérifiée soit payée deux fois à deux comptes). 5. Conserver la preuve de l'acceptation des CGU et de la politique de confidentialité. |
| Base légale (la raison juridique qui autorise le traitement) | Compte, identités, XP, niveau, sessions, acceptation des CGU : exécution du contrat, article 6.1.b du RGPD. Classement public : intérêt légitime, article 6.1.f — faire vivre le classement est le but du service et ne surprend personne qui s'y inscrit. Prévention de la double attribution : intérêt légitime, article 6.1.f — l'équité du jeu et l'intégrité du registre d'XP. |
| Catégories de données | Handle du compte et nom affiché ; identités de plateforme (plateforme, identifiant externe chez la plateforme, handle affiché, dates de rattachement) ; XP, niveau, XP maximale atteinte et entrées du registre (action, montant, type, motif, date, clé d'attribution) ; sessions (jeton, date d'expiration) ; journal d'audit (type d'opération, compteurs, sans identité de personne) ; journaux applicatifs (méthode, chemin, code de réponse, adresse IP source, identifiant de requête) ; acceptation des CGU (version acceptée, horodatage). |
| Personnes concernées | Les Dachis, c'est-à-dire les personnes qui se connectent et obtiennent un compte. Les titulaires d'un compte de plateforme vu par le worker mais jamais rattaché à un compte Dachi (identité « jamais rattachée »). |
| Destinataires | Aucun. Seul l'exploitant a accès aux données. Aucune donnée n'est vendue, louée ni transmise à des fins publicitaires. |
| Sous-traitants (une entreprise qui traite les données pour le compte d'une autre) | Aucun. Le service est auto-hébergé sur une infrastructure privée exploitée par le responsable de traitement ; aucun hébergeur tiers n'intervient. |
| Transferts hors Union européenne | Aucun transfert de nos propres données. Les plateformes de connexion (Twitch, Google, Discord) sont des responsables de traitement indépendants pour l'authentification : la connexion se déroule sous leurs règles, pas sous les nôtres. |
| Durées de conservation | Compte et identités rattachées : 1 095 jours (trois ans) après la dernière connexion, puis anonymisation. Identité jamais rattachée : 1 095 jours après sa création, puis anonymisation. Entrées du registre : conservées après l'effacement du compte, sous forme pseudonyme, tant que la prévention d'une double attribution l'exige ; elles ne sont pas réidentifiables sans la clé détenue par le serveur. Événements de plateforme traités : 30 jours. Journal d'audit : 1 095 jours. Journaux applicatifs : 30 jours, par la rotation du pipeline de journaux du cluster (réglage hors dépôt, à vérifier à chaque revue annuelle). Sessions : 30 jours, ou jusqu'à la déconnexion. |
| Mesures de sécurité | HTTPS sur tout le site. Cookies de session HttpOnly, donc illisibles par le JavaScript de la page. Aucun mot de passe stocké : la connexion passe uniquement par OAuth chez les plateformes. Conteneurs non privilégiés (non-root) avec système de fichiers en lecture seule. Limites de débit sur les routes d'authentification et d'écriture. Journal d'audit des opérations sensibles, sans identité de personne. Pseudonymisation HMAC (une empreinte calculée avec une clé secrète, réversible seulement avec cette clé) des identifiants de plateforme à l'effacement. Accès à l'infrastructure et aux données limité à l'exploitant. |
| Date de mise à jour | 15 novembre 2026 |

## Notes d'exploitation

- La clé de pseudonymisation est le secret `ERASURE_PEPPER`, détenu par le serveur et absent de
  la base. Sans elle, l'empreinte stockée ne ramène à aucun compte de plateforme.
- Le journal d'audit ne porte ni handle, ni identifiant de plateforme, ni identifiant de compte :
  il ne peut pas reconstituer une personne après un effacement.
- Les durées de 1 095 et 30 jours sont celles des constantes de
  `packages/ledger/src/privacy.ts` ; le CronJob de purge les applique. Changer une constante
  change le présent registre : les deux se modifient dans le même commit.
- Une violation de données se traite selon la procédure de `docs/legal/conformite.md` ; une
  demande de droits selon `docs/legal/runbook-droits.md`.
