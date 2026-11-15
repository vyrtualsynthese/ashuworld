# Runbook — répondre à une demande de droits

Ce fichier décrit ce que fait l'exploitant quand une personne demande à voir, corriger ou faire
effacer ses données. Les demandes arrivent par courriel à info@ashudev.com : le site n'a aucun
bouton de suppression ni d'export, et la politique de confidentialité le dit.

## Les droits et ce que le service permet

| Droit | Ce qu'il couvre | Ce que le code permet aujourd'hui |
|---|---|---|
| Accès | Savoir quelles données sont détenues et en recevoir une copie. | `export-fan <handle>` produit un document JSON : compte, XP, niveau, identités rattachées et toutes les entrées du registre, y compris celles déjà abandonnées. |
| Portabilité | Recevoir ses données dans un format lisible par machine. | Le même export JSON sert de réponse : il est structuré, daté et complet pour le compte. |
| Rectification | Corriger une donnée fausse. | Le handle affiché de chaque identité est rafraîchi depuis la plateforme à la connexion suivante. Le handle du compte Dachi, lui, est figé à la création : aucune route ne le renomme. Si le handle est faux, la réponse le dit, et l'effacement suivi d'une nouvelle connexion est la seule voie existante. |
| Effacement | Faire disparaître la personne. | `erase-fan <handle>` pour un compte ; `erase-identity <provider> <handle>` ou `erase-identity-id <uuid>` pour un compte de plateforme jamais rattaché. |
| Opposition | Refuser un traitement fondé sur l'intérêt légitime. | Le classement public et la prévention de la double attribution reposent sur l'intérêt légitime. Une opposition au classement se satisfait par l'effacement : le profil répond alors 404 et sort du classement. L'opposition à la prévention de la double attribution ne peut pas être satisfaite : c'est la seule donnée qui survit à l'effacement, et elle est nécessaire pour qu'une action déjà payée ne le soit pas deux fois. La réponse explique ce refus et son motif. |
| Limitation | Geler le traitement sans effacer. | Aucun mécanisme de gel n'existe dans le code. La réponse le dit et propose l'effacement, qui arrête tout traitement de la personne sauf l'empreinte pseudonyme décrite ci-dessus. |

## Le délai

Un mois à compter de la réception de la demande, preuve d'identité comprise. Si la demande est
complexe ou si plusieurs demandes arrivent en même temps, le délai peut être prolongé de deux
mois, à condition d'envoyer une réponse motivée avant la fin du premier mois : dire pourquoi, et
donner la nouvelle échéance.

Si la demande est refusée, la réponse est motivée et rappelle la voie de recours : réclamation
à la CNIL (l'autorité française qui contrôle le respect du RGPD), 3 place de Fontenoy, TSA 80715,
75334 Paris Cedex 07, ou depuis cnil.fr.

## Vérifier l'identité

Une preuve suffit, parmi :

- une session ouverte au moment de la demande, quand le canal la montre (demande remise de la
  main à la main, ou canal déjà authentifié) ;
- un défi passé par la plateforme : la personne met un code à usage unique dans son nom affiché
  ou son profil chez la plateforme, puis se reconnecte ; le handle stocké est rafraîchi à cette
  connexion, et l'exploitant vérifie qu'il porte le code ;
- un message envoyé depuis le compte de plateforme lui-même (message privé Twitch, courriel
  depuis le compte Google, message Discord) : l'expéditeur est alors la preuve.

Ne jamais demander de mot de passe, de jeton OAuth ni de code de connexion. Ne jamais demander
la clé `ERASURE_PEPPER` ni aucun secret d'infrastructure.

Cas d'un compte de plateforme jamais rattaché : il n'y a pas de compte Dachi, donc pas de
session possible. La preuve est un message depuis ce compte ou un code dans son profil, envoyé à
info@ashudev.com.

## Les commandes

Toutes vivent dans `apps/worker/src/cli.ts` et prennent la forme
`node dist/worker.js <commande> <arguments>`.

| Commande | Effet | Garde |
|---|---|---|
| `export-fan <handle>` | Affiche en JSON le compte et tout son registre. Sort en erreur si aucun compte actif ne porte ce handle. | Aucune : lecture seule. |
| `erase-fan <handle>` | Anonymise le compte : handle aléatoire `deleted_…`, nom « Compte supprimé », sessions supprimées, identités détachées et pseudonymisées, gains en cours abandonnés. Affiche le nombre d'identités et d'entrées abandonnées. | `ERASURE_PEPPER` obligatoire ; refuse un handle inconnu ou déjà effacé, sans rien écrire. |
| `erase-identity <provider> <handle>` | Anonymise un compte de plateforme jamais rattaché. Refuse un handle ambigu en listant les identifiants concernés. | `ERASURE_PEPPER` obligatoire ; refuse un handle ambigu, un handle inconnu, une identité encore rattachée. |
| `erase-identity-id <uuid>` | La même chose, adressée par l'identifiant que la commande précédente a listé. | `ERASURE_PEPPER` obligatoire ; refuse un identifiant qui n'est pas un UUID, une ligne absente, une identité encore rattachée. |
| `purge [--dry-run]` | Applique les fenêtres de conservation (voir le registre). Sans argument, efface ; avec `--dry-run`, compte sans écrire. | `PURGE_CONFIRM` doit valoir exactement `purge-ashuworld`. |

Quand `erase-identity` répond que plusieurs identités partagent le provider et le handle, elle
imprime la liste des UUID. Choisir celui de la personne (par exemple celui dont la date de
création correspond à la demande) et le passer à `erase-identity-id`. Ne jamais prendre le
premier de la liste au hasard.

## Où les exécuter

Jamais de SQL manuel : une écriture directe serait un troisième écrivain à côté de l'API et du
worker, et le registre perdrait la garantie qu'une action n'est payée qu'une fois. Les commandes
passent par le même code que le service.

Le plus sûr est de partir du CronJob de purge : il porte déjà `DATABASE_URL`, `ERASURE_PEPPER`,
`PURGE_CONFIRM` et la bonne image worker. On crée un Job à partir de ce modèle en remplaçant la
commande, sans toucher au CronJob lui-même.

```bash
# 1. Le nom exact du CronJob et l'espace de noms du déploiement.
kubectl get cronjob -n <namespace>

# 2. Un Job ponctuel dérivé du CronJob, commande remplacée, appliqué sans passer par un fichier.
kubectl create job --from=cronjob/<release>-purge droits-2026-11-15 \
  --dry-run=client -o yaml \
  | kubectl patch --local -f - --type=json \
      -p '[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["node","dist/worker.js","export-fan","<handle>"]}]' \
      -o yaml \
  | kubectl apply -n <namespace> -f -

# 3. La sortie, puis le nettoyage.
kubectl logs -f job/droits-2026-11-15 -n <namespace>
kubectl delete job droits-2026-11-15 -n <namespace>
```

Remplacer la valeur de `command` par la commande voulue, par exemple
`["node","dist/worker.js","erase-fan","<handle>"]` ou
`["node","dist/worker.js","purge","--dry-run"]`. Pour une purge réelle, aucun remplacement n'est
nécessaire : `kubectl create job --from=cronjob/<release>-purge purge-manuel -n <namespace>`
suffit. Lancer toujours `purge --dry-run` avant une purge réelle et lire les compteurs.

Une autre exécution ponctuelle de l'image worker fonctionne, à condition de lui fournir les
mêmes deux variables, `DATABASE_URL` et `ERASURE_PEPPER`, par référence à leurs Secrets. Ne
jamais les écrire en clair dans une ligne de commande : elles resteraient dans l'historique du
shell et dans `kubectl describe`.

Le code de sortie est 0 en cas de succès et non nul en cas de refus. Un refus n'a rien écrit :
l'exploitant peut corriger l'argument et relancer.

## Vérifier après l'effacement

- Le profil public répond 404 : `curl -s -o /dev/null -w '%{http_code}\n' https://<hôte>/api/public/fans/<handle>`.
- Le classement ne liste plus le compte : chercher le handle dans
  `curl -s https://<hôte>/api/public/ladder`. Une identité jamais rattachée disparaît du
  classement des comptes libres dès qu'elle n'a plus de gain vivant.
- `export-fan <handle>` ne trouve plus de compte actif.
- Si la personne se reconnecte avec la même identité de plateforme, elle repart d'un compte neuf
  à 0 XP, sans bonus de bienvenue : la clé d'attribution déjà dépensée et les gains abandonnés
  empêchent un second paiement.
- Les compteurs affichés par `erase-fan` (identités, entrées abandonnées) sont notés dans le
  compte rendu de la demande.

## Ce qu'on consigne, et ce qu'on ne consigne jamais

À consigner, dans un fichier tenu par l'exploitant hors du dépôt (il contient des données
personnelles) :

- la date de réception et la date de réponse ;
- le droit exercé (accès, rectification, effacement, opposition, portabilité, limitation) ;
- la preuve d'identité retenue, en une ligne, sans la recopier ;
- les commandes exécutées, avec leurs arguments génériques et leur code de sortie ;
- le résultat : compteurs, 404 constaté, suite donnée ou motif du refus.

À ne jamais consigner, ni dans ce fichier, ni dans un ticket, ni dans un journal :

- les identifiants de session ;
- les identifiants externes des plateformes (l'identifiant du compte chez Twitch, Google ou
  Discord) ;
- le handle effacé ;
- les secrets (`ERASURE_PEPPER`, `PURGE_CONFIRM`, `DATABASE_URL`).

Le journal d'audit du service ne porte que des compteurs, sans identité de personne : il ne
remplace pas ce compte rendu, il le complète.
