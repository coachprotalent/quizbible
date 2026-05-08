# Quiz Bible

Quiz Bible est une application web mobile-first pour apprendre la Bible en jouant : categories Ancien/Nouveau Testament, niveaux progressifs, questions chronometrees, challenges d'etude, scores, classement et explications apres chaque reponse.

## Fonctionnalites

- Modes de jeu par categorie : Pentateuque, Evangiles, Actes, Epitres, Apocalypse, personnages, contexte historique, etc.
- Niveaux : debutant, intermediaire, avance, expert.
- Parties de 5, 10, 15 ou 20 questions avec limite de 15, 30, 45 ou 60 secondes.
- Score : +10 pour une bonne reponse, bonus vitesse jusqu'a +5.
- Explication, bonne reponse et reference biblique apres chaque question.
- Challenges 7 jours : Moise, David, Daniel, Paul, prophetes majeurs, paraboles, miracles, femmes importantes, rois, empires.
- Classement local.
- Mode Competition avec salons publics/prives, code d'invitation, tours chronometres et classement par salon.
- Admin protege par identifiants serveur.
- Generation optionnelle de questions avec Azure OpenAI, avec fallback local si Azure n'est pas configure.

## Stack

- Node.js 18+ sans dependance externe.
- Frontend statique HTML/CSS/JavaScript.
- Donnees JSON locales dans `data/`.
- Reverse proxy Nginx pour `quizbible.traillearn.org`.

## Variables d'environnement

Copier `.env.example` vers `.env` :

```bash
PORT=5174
APP_BASE_URL=https://quizbible.traillearn.org

AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_API_VERSION=

ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

Ne jamais exposer les variables Azure dans le frontend. Elles sont uniquement lues par `server.js`.

## Installation

```bash
npm install
```

Le projet n'a actuellement aucune dependance npm, mais la commande reste compatible avec un deploiement Node standard.

## Lancement local

```bash
npm run dev
```

Puis ouvrir :

```text
http://localhost:5174
```

Admin :

```text
http://localhost:5174/admin
```

## Build / validation

```bash
npm run build
```

Cette commande verifie les fichiers requis et la validite JSON des donnees.

## API principale

`POST /api/generate-questions`

Entree :

```json
{
  "category": "evangiles",
  "level": "intermediaire",
  "count": 10,
  "questionTypes": ["qcm", "vrai_faux", "personnage"]
}
```

Sortie :

```json
{
  "questions": [
    {
      "id": "...",
      "question": "...",
      "type": "qcm",
      "options": ["...", "...", "...", "..."],
      "correctAnswer": "...",
      "explanation": "...",
      "reference": "Daniel 2",
      "difficulty": "intermediaire",
      "category": "livres prophetiques"
    }
  ]
}
```

Si Azure OpenAI n'est pas configure, l'API renvoie des questions locales actives.

## Mode Competition

Le mode Competition est un salon rapide pour jouer tout de suite avec des amis.

Creation rapide :

- nom du joueur ;
- categorie, par defaut `Quiz au hasard` ;
- difficulte, par defaut `Intermediaire` ;
- nombre de questions, par defaut `10` ;
- chrono par question, par defaut `30 secondes`.

Apres creation, l'application genere un code court de type `BIBLE-482`, affiche un lien d'invitation et place le createur dans l'ecran d'attente. Les amis rejoignent avec le code ou le lien, puis le createur clique sur `Lancer la partie`.

Options avancees repliees :

- temps total de la partie ;
- salon public ou prive ;
- types de questions ;
- activation ou desactivation des explications ;
- source IA Azure ou questions locales.

Tous les joueurs recoivent le meme set de questions pour la partie. Pendant le chrono, une reponse est seulement enregistree. Quand le chrono arrive a zero, le serveur calcule les points, affiche la bonne reponse, une courte explication si activee et le classement provisoire. A la fin, il affiche le classement final.

Endpoints :

```text
POST /api/rooms
GET /api/rooms
GET /api/rooms/:id
GET /api/rooms/:roomCode/state?participantId=...
POST /api/rooms/:id/join
POST /api/rooms/:id/leave
POST /api/rooms/:id/start-round
GET /api/rooms/:id/current-round
POST /api/rounds/:id/answer
GET /api/rooms/:id/leaderboard
POST /api/rooms/:id/close
POST /api/ai/generate-round-questions
POST /api/ai/validate-questions
```

Synchronisation :

- le serveur est la source de verite pour la phase, le chrono, la question active, les reponses et les scores ;
- le frontend restaure le salon apres refresh via `localStorage` puis `GET /api/rooms/:roomCode/state?participantId=...` ;
- le frontend utilise un polling court si WebSocket n'est pas disponible ;
- les points restent a `0` jusqu'a la fin du chrono ;
- apres correction, une pause de preparation lance automatiquement la question suivante.

Phases serveur :

```text
waiting
starting
question_active
question_reveal
between_questions
finished
```

Scoring competition :

```text
score = basePoints + round(speedBonusMax * remainingTime / questionTimeLimit)
```

Par defaut :

- bonne reponse : 10 points ;
- bonus vitesse : jusqu'a 10 points ;
- mauvaise reponse ou non-reponse : 0 point.

Les questions de partie sont stockees dans `data/roundQuestions.json` avant d'etre envoyees aux participants. Tous les participants d'un meme salon recoivent le meme set de questions.

Pipeline IA :

1. generation des questions avec Azure OpenAI ;
2. validation automatique par Azure OpenAI ;
3. rejet des questions invalides ou doublons recents ;
4. trois tentatives maximum ;
5. fallback local si la generation ou la validation echoue.

## Azure OpenAI

Le serveur appelle l'API Chat Completions Azure avec le prompt systeme suivant :

```text
Tu es un generateur de quiz biblique pedagogique. Genere uniquement des questions bibliques fiables, claires, non ambigues, avec une bonne reponse exacte, des distracteurs plausibles, une explication courte et une reference biblique si possible. Ne genere pas de doctrine controversee comme verite absolue. Pour les questions historiques, distingue clairement le texte biblique du contexte historique issu des Bibles d etude. Reponds uniquement en JSON valide.
```

Validation cote serveur :

- champs obligatoires presents ;
- options presentes ;
- bonne reponse incluse dans les options ;
- QCM limite a 4 options ;
- nettoyage simple des entrees utilisateur ;
- rate limiting simple sur la generation IA.

## Admin

La page `/admin` permet :

- voir les questions ;
- ajouter, modifier, supprimer et activer/desactiver une question ;
- voir les categories ;
- voir les parties jouees et scores ;
- voir, creer, modifier et supprimer les challenges ;
- voir tous les salons de competition ;
- fermer ou supprimer un salon ;
- relancer la generation IA d'un salon ;
- voir les questions de tours et les erreurs Azure OpenAI ;
- tester la generation Azure OpenAI via le bouton `Generer 20 questions`.

Les identifiants viennent de :

```text
ADMIN_USERNAME
ADMIN_PASSWORD
```

## Deploiement Nginx

1. Lancer l'application Node sur le serveur, par exemple avec systemd ou PM2 :

```bash
PORT=5174 npm start
```

2. Copier `deploy/nginx.quizbible.conf` dans `/etc/nginx/sites-available/quizbible.traillearn.org`.

3. Activer le site :

```bash
sudo ln -s /etc/nginx/sites-available/quizbible.traillearn.org /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

4. Ajouter SSL :

```bash
sudo certbot --nginx -d quizbible.traillearn.org
```

## Roadmap V2

- Mode multijoueur.
- Salles privees.
- Quiz en direct pour groupes bibliques.
- Import de questions CSV.
- Export des scores.
- Badges et trophees.
- Compte utilisateur.
- Sauvegarde de progression.
- Mode Etude avant quiz.
- Mode Verset a memoriser.
- Support FR/EN.
