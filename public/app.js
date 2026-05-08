const state = {
  meta: { categories: [], levels: [], questionTypes: [] },
  questions: [],
  currentIndex: 0,
  score: 0,
  answers: [],
  timerId: null,
  startedAt: 0,
  timeLimit: 30,
  playerName: 'Anonyme',
  category: 'random',
  level: 'debutant',
  remaining: 30
};

const competition = {
  room: null,
  participant: null,
  round: null,
  questions: [],
  index: 0,
  score: 0,
  timerId: null,
  pollId: null,
  questionStartedAt: 0,
  remaining: 30,
  lastState: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

init();

async function init() {
  bindNavigation();
  bindForms();
  $('#themeToggle').addEventListener('click', toggleTheme);
  state.meta = await api('/api/meta');
  fillSelects();
  await Promise.all([loadChallenges(), loadLeaderboard(), loadRooms()]);
  handleInitialHash();
  restoreCompetitionSession();
  if (location.pathname === '/admin') showView('admin');
}

function handleInitialHash() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('competition/')) {
    showView('competition');
    $('#roomJoinForm').elements.code.value = hash.split('/')[1] || '';
    return;
  }
  if (hash && $(`#${hash}View`)) showView(hash);
}

function bindNavigation() {
  $$('[data-view]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });
}

function showView(view) {
  $$('.view').forEach((section) => section.classList.remove('active'));
  $$('.nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $(`#${view}View`)?.classList.add('active');
  location.hash = view;
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'challenges') loadChallenges();
  if (view === 'competition') loadRooms();
}

function bindForms() {
  $('#gameSetup').addEventListener('submit', startGame);
  $('#nextQuestion').addEventListener('click', nextQuestion);
  $('#adminLogin').addEventListener('submit', adminLogin);
  $('#adminLogout').addEventListener('click', adminLogout);
  $('#adminRefresh').addEventListener('click', loadAdmin);
  $('#adminGenerate').addEventListener('click', adminGenerate);
  $('#questionEditor').addEventListener('submit', addQuestion);
  $('#challengeEditor').addEventListener('submit', addChallenge);
  $('#questionCancel').addEventListener('click', resetQuestionEditor);
  $('#challengeCancel').addEventListener('click', resetChallengeEditor);
  $('#roomCreateForm').addEventListener('submit', createRoom);
  $('#roomJoinForm').addEventListener('submit', joinRoomByCode);
  $('#startRound').addEventListener('click', startCompetitionRound);
  $('#leaveRoom').addEventListener('click', leaveCompetitionRoom);
  $('#copyRoomLink').addEventListener('click', copyRoomLink);
  $('#competitionNext').addEventListener('click', nextCompetitionQuestion);
  $('#advancedToggle').addEventListener('click', () => $('#advancedOptions').classList.toggle('hidden'));
  $$('.stepper button').forEach((button) => button.addEventListener('click', stepNumberInput));
}

function fillSelects() {
  const categoryOptions = state.meta.categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`).join('');
  const levelOptions = state.meta.levels.map((level) => `<option value="${escapeHtml(level.id)}">${escapeHtml(level.label)}</option>`).join('');
  const typeOptions = state.meta.questionTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
  ['#categorySelect', '#adminCategorySelect', '#challengeCategorySelect', '#roomCategorySelect'].forEach((selector) => $(selector).innerHTML = categoryOptions);
  ['#levelSelect', '#adminLevelSelect', '#challengeLevelSelect', '#roomLevelSelect'].forEach((selector) => $(selector).innerHTML = levelOptions);
  $('#adminTypeSelect').innerHTML = typeOptions;
  $('#roomQuestionTypes').innerHTML = typeOptions;
  $('#roomCategorySelect').value = 'random';
  $('#roomLevelSelect').value = 'intermediaire';
}

function stepNumberInput(event) {
  const button = event.currentTarget;
  const input = button.closest('.stepper').querySelector(`input[name="${button.dataset.target}"]`);
  const min = Number(input.min || 0);
  const max = Number(input.max || 999);
  const next = Number(input.value || 0) + Number(button.dataset.step || 1);
  input.value = Math.max(min, Math.min(max, next));
}

async function startGame(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.playerName = form.get('playerName') || 'Anonyme';
  state.category = form.get('category');
  state.level = form.get('level');
  state.timeLimit = Number(form.get('timeLimit'));
  state.currentIndex = 0;
  state.score = 0;
  state.answers = [];
  state.startedAt = Date.now();
  const response = await api('/api/start-game', {
    method: 'POST',
    body: {
      category: state.category,
      level: state.level,
      count: Number(form.get('count'))
    }
  });
  state.questions = response.questions;
  $('#gameBoard').classList.remove('hidden');
  $('#results').classList.add('hidden');
  renderQuestion();
}

function renderQuestion() {
  clearInterval(state.timerId);
  const question = state.questions[state.currentIndex];
  $('#feedback').classList.add('hidden');
  $('#questionCounter').textContent = `Question ${state.currentIndex + 1}/${state.questions.length}`;
  $('#score').textContent = `${state.score} pts`;
  $('#questionType').textContent = question.type.replaceAll('_', ' ');
  $('#questionText').textContent = question.question;
  $('#answers').innerHTML = question.options.map((option) => `<button class="answer" type="button">${escapeHtml(option)}</button>`).join('');
  $$('.answer').forEach((button) => button.addEventListener('click', () => answerQuestion(button.textContent)));
  state.remaining = state.timeLimit;
  tickTimer();
  state.timerId = setInterval(() => {
    state.remaining -= 1;
    tickTimer();
    if (state.remaining <= 0) answerQuestion('');
  }, 1000);
}

function tickTimer() {
  $('#timer').textContent = `${Math.max(0, state.remaining)}s`;
  $('#timerBar').style.width = `${Math.max(0, (state.remaining / state.timeLimit) * 100)}%`;
}

async function answerQuestion(answer) {
  clearInterval(state.timerId);
  const question = state.questions[state.currentIndex];
  const review = await api('/api/check-answer', {
    method: 'POST',
    body: {
      questionId: question.id,
      answer,
      timeLeft: state.remaining,
      timeLimit: state.timeLimit
    }
  });
  state.answers.push({ questionId: question.id, answer, timeLeft: state.remaining, timeLimit: state.timeLimit });
  state.score += review.points;
  $('#score').textContent = `${state.score} pts`;
  $$('.answer').forEach((button) => {
    button.disabled = true;
    if (button.textContent === review.correctAnswer) button.classList.add('correct');
    if (answer && button.textContent === answer && !review.isCorrect) button.classList.add('wrong');
  });
  $('#feedbackTitle').textContent = review.isCorrect ? 'Bonne reponse' : 'A retenir';
  $('#feedbackText').textContent = `${review.explanation} Bonne reponse : ${review.correctAnswer}.`;
  $('#feedbackReference').textContent = review.reference ? `Reference : ${review.reference}` : '';
  $('#feedback').classList.remove('hidden');
  $('#nextQuestion').textContent = state.currentIndex + 1 >= state.questions.length ? 'Voir le resultat' : 'Question suivante';
}

function nextQuestion() {
  state.currentIndex += 1;
  if (state.currentIndex >= state.questions.length) {
    finishGame();
    return;
  }
  renderQuestion();
}

async function finishGame() {
  const response = await api('/api/submit-game', {
    method: 'POST',
    body: {
      playerName: state.playerName,
      category: state.category,
      level: state.level,
      timeLimit: state.timeLimit,
      duration: Math.round((Date.now() - state.startedAt) / 1000),
      answers: state.answers
    }
  });
  $('#gameBoard').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#results').innerHTML = `
    <p class="eyebrow">Resultat final</p>
    <h2>${response.session.score} points</h2>
    <p>${response.percent}% de reussite · Niveau estime : <strong>${escapeHtml(response.levelEstimate)}</strong></p>
    <p>${escapeHtml(response.encouragement)}</p>
    <ul>${response.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <button class="primary" data-view="play">Rejouer</button>
  `;
  $('#results [data-view]').addEventListener('click', () => showView('play'));
  loadLeaderboard();
}

async function loadChallenges() {
  const { challenges } = await api('/api/challenges');
  $('#challengeGrid').innerHTML = challenges.map((challenge) => `
    <article class="challenge-card">
      <p class="pill">${escapeHtml(challenge.level)}</p>
      <h3>${escapeHtml(challenge.title)}</h3>
      <p>${escapeHtml(challenge.description)}</p>
      <div class="mini-progress"><span style="width:${Number(challenge.progression || 0)}%"></span></div>
      <p>${escapeHtml(challenge.summary || 'Quiz quotidien et resume d apprentissage.')}</p>
      <button class="secondary" data-category="${escapeHtml(challenge.category)}" data-level="${escapeHtml(challenge.level)}">Quiz quotidien</button>
    </article>
  `).join('');
  $$('#challengeGrid button').forEach((button) => button.addEventListener('click', () => {
    showView('play');
    $('#categorySelect').value = button.dataset.category;
    $('#levelSelect').value = button.dataset.level;
  }));
}

async function loadLeaderboard() {
  const { leaderboard } = await api('/api/leaderboard');
  $('#leaderboardRows').innerHTML = leaderboard.length ? leaderboard.map((row) => `
    <tr>
      <td>${escapeHtml(row.playerName)}</td>
      <td><strong>${row.score}</strong></td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.level)}</td>
      <td>${new Date(row.createdAt).toLocaleDateString('fr-FR')}</td>
    </tr>
  `).join('') : '<tr><td colspan="5">Aucun score pour le moment.</td></tr>';
}

async function loadRooms() {
  const { rooms } = await api('/api/rooms');
  $('#roomsGrid').innerHTML = rooms.length ? rooms.map((room) => `
    <article class="challenge-card">
      <p class="pill">${escapeHtml(room.status)}</p>
      <h3>${escapeHtml(room.name)}</h3>
      <p>${escapeHtml(room.description || 'Competition biblique chronometree.')}</p>
      <p>${escapeHtml(room.category)} · ${escapeHtml(room.difficulty)} · ${room.questionsPerRound} questions</p>
      <p>${new Date(room.startDate).toLocaleString('fr-FR')} - ${new Date(room.endDate).toLocaleString('fr-FR')}</p>
      <button class="secondary" data-room-open="${escapeHtml(room.id)}">Ouvrir</button>
    </article>
  `).join('') : '<p>Aucun salon public actif.</p>';
  $$('[data-room-open]').forEach((button) => button.addEventListener('click', () => openRoom(button.dataset.roomOpen)));
}

async function createRoom(event) {
  event.preventDefault();
  const submit = event.submitter;
  setButtonLoading(submit, true);
  setRoomMessage('Creation du salon...', true);
  const form = new FormData(event.currentTarget);
  try {
    const startDate = new Date();
    const totalMinutes = Number(form.get('roundTimeLimit') || 30);
    const endDate = new Date(startDate.getTime() + totalMinutes * 60 * 1000);
    const creatorId = localStorage.getItem('quizBibleCreatorId') || `creator-${cryptoRandom()}`;
    localStorage.setItem('quizBibleCreatorId', creatorId);
    const selectedTypes = form.getAll('questionTypes');
    const { room } = await api('/api/rooms', {
      method: 'POST',
      body: {
        name: form.get('name'),
        description: `Cree par ${form.get('playerName')}`,
        category: form.get('category'),
        difficulty: form.get('difficulty'),
        creatorId,
        isPublic: form.get('isPublic') === 'on',
        questionMode: 'same',
        questionTypes: selectedTypes.length ? selectedTypes : ['qcm', 'vrai_faux', 'personnage'],
        explanationsEnabled: form.get('explanationsEnabled') !== null,
        questionSource: form.get('questionSource') || 'ai',
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        questionTimeLimit: Number(form.get('questionTimeLimit')),
        roundTimeLimit: totalMinutes,
        questionsPerRound: Number(form.get('questionsPerRound'))
      }
    });
    await joinRoom(room.id, form.get('playerName'));
    event.currentTarget.reset();
    resetQuickRoomDefaults();
    setRoomMessage(`Salon cree : ${room.accessCode}`, true);
    await loadRooms();
  } catch (error) {
    console.error('createRoom failed', error);
    setRoomMessage(error.message || 'Creation impossible.');
  } finally {
    setButtonLoading(submit, false);
  }
}

async function joinRoomByCode(event) {
  event.preventDefault();
  const submit = event.submitter;
  setButtonLoading(submit, true);
  setRoomActionMessage('Connexion au salon...', true);
  const form = new FormData(event.currentTarget);
  const code = String(form.get('code')).trim().split('/').filter(Boolean).pop();
  try {
    await joinRoom(code, form.get('playerName'));
    setRoomActionMessage('Salon rejoint.', true);
  } catch (error) {
    console.error('joinRoom failed', error);
    setRoomActionMessage(error.message || 'Impossible de rejoindre le salon.');
  } finally {
    setButtonLoading(submit, false);
  }
}

async function openRoom(roomId) {
  try {
    const { room } = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    competition.room = room;
    persistRoom(room);
    await loadCompetitionState();
    startCompetitionPolling();
  } catch (error) {
    console.error('openRoom failed', error);
    setRoomActionMessage(error.message || 'Ouverture du salon impossible.');
  }
}

async function joinRoom(roomIdOrCode, playerName) {
  const known = JSON.parse(localStorage.getItem('quizBibleParticipants') || '{}');
  const { room } = await api(`/api/rooms/${encodeURIComponent(roomIdOrCode)}`);
  const response = await api(`/api/rooms/${encodeURIComponent(room.id)}/join?code=${encodeURIComponent(room.accessCode)}`, {
    method: 'POST',
    body: { playerName, participantId: known[room.id] }
  });
  known[room.id] = response.participant.id;
  localStorage.setItem('quizBibleParticipants', JSON.stringify(known));
  localStorage.setItem('quizBiblePlayerName', response.participant.playerName);
  competition.room = response.room;
  competition.participant = response.participant;
  persistRoom(response.room);
  renderCompetitionState({ room: response.room, participant: response.participant, participants: response.room.participants || [], leaderboard: [] });
  await loadCompetitionState();
  startCompetitionPolling();
}

function renderRoom() {
  const room = competition.room;
  if (!room) return;
  $('#roomPanel').classList.remove('hidden');
  $('#roomStatus').textContent = `${room.status} · ${room.difficulty}`;
  $('#roomTitle').textContent = room.name;
  $('#roomDescription').textContent = room.description || 'En attente des amis. Partagez le code puis lancez la partie.';
  $('#roomParticipants').textContent = room.participantCount || room.participants?.length || 0;
  $('#roomRounds').textContent = room.roundCount || room.rounds?.length || 0;
  $('#roomCode').textContent = room.accessCode;
  $('#roomRoundsHistory').innerHTML = (room.rounds || []).map((round) => `
    <article class="admin-item">
      <strong>Partie ${round.roundNumber} · ${round.status}</strong>
      <p>${new Date(round.startsAt).toLocaleString('fr-FR')} - ${new Date(round.endsAt).toLocaleString('fr-FR')}</p>
      <p>IA: ${round.generatedByAI ? 'oui' : 'fallback local'} · validation: ${escapeHtml(round.validationStatus)}</p>
    </article>
  `).join('') || '<p>Aucun tour.</p>';
  loadRoomLeaderboard();
}

async function refreshCurrentRound() {
  if (!competition.room) return;
  const data = await api(`/api/rooms/${encodeURIComponent(competition.room.id)}/current-round?code=${encodeURIComponent(competition.room.accessCode)}`);
  competition.round = data.round;
  competition.questions = data.questions || [];
  if (competition.round && competition.questions.length) {
    competition.index = 0;
    competition.score = 0;
    $('#competitionResults').classList.add('hidden');
    $('#competitionBoard').classList.remove('hidden');
    renderCompetitionQuestion();
  }
}

async function startCompetitionRound() {
  if (!competition.room) return;
  const creatorId = localStorage.getItem('quizBibleCreatorId') || '';
  const data = await api(`/api/rooms/${encodeURIComponent(competition.room.id)}/start-round?code=${encodeURIComponent(competition.room.accessCode)}`, {
    method: 'POST',
    body: { creatorId }
  });
  competition.round = data.round;
  competition.questions = data.questions;
  competition.index = 0;
  competition.score = 0;
  $('#competitionResults').classList.add('hidden');
  $('#competitionBoard').classList.remove('hidden');
  await openRoom(competition.room.id);
  renderCompetitionQuestion();
}

function renderCompetitionQuestion() {
  clearInterval(competition.timerId);
  const question = competition.questions[competition.index];
  if (!question) return finishCompetitionRound();
  competition.remaining = competition.room.questionTimeLimit;
  competition.questionStartedAt = Date.now();
  $('#competitionFeedback').classList.add('hidden');
  $('#competitionCounter').textContent = `Question ${competition.index + 1}/${competition.questions.length}`;
  $('#competitionScore').textContent = `${competition.score} pts`;
  $('#competitionType').textContent = question.type.replaceAll('_', ' ');
  $('#competitionQuestion').textContent = question.question;
  $('#competitionAnswers').innerHTML = question.options.map((option) => `<button class="answer" type="button">${escapeHtml(option)}</button>`).join('');
  $$('#competitionAnswers .answer').forEach((button) => button.addEventListener('click', () => submitCompetitionAnswer(button.textContent)));
  tickCompetitionTimer();
  competition.timerId = setInterval(() => {
    competition.remaining -= 1;
    tickCompetitionTimer();
    if (competition.remaining <= 0) submitCompetitionAnswer('');
  }, 1000);
}

function tickCompetitionTimer() {
  $('#competitionTimer').textContent = `${Math.max(0, competition.remaining)}s`;
  $('#competitionTimerBar').style.width = `${Math.max(0, (competition.remaining / competition.room.questionTimeLimit) * 100)}%`;
}

async function submitCompetitionAnswer(selectedAnswer) {
  clearInterval(competition.timerId);
  const question = competition.questions[competition.index];
  const participant = competition.participant || getStoredParticipant(competition.room.id);
  if (!participant) {
    alert('Rejoignez le salon avant de repondre.');
    return;
  }
  const responseTimeMs = Date.now() - competition.questionStartedAt;
  const result = await api(`/api/rounds/${encodeURIComponent(competition.round.id)}/answer`, {
    method: 'POST',
    body: { participantId: participant.id || participant, questionId: question.id, selectedAnswer, responseTimeMs }
  });
  competition.score += result.answer.totalPoints;
  $('#competitionScore').textContent = `${competition.score} pts`;
  $$('#competitionAnswers .answer').forEach((button) => {
    button.disabled = true;
    if (button.textContent === result.correctAnswer) button.classList.add('correct');
    if (selectedAnswer && button.textContent === selectedAnswer && !result.answer.isCorrect) button.classList.add('wrong');
  });
  $('#competitionFeedbackTitle').textContent = result.answer.isCorrect ? `+${result.answer.totalPoints} points` : '0 point';
  $('#competitionFeedbackText').textContent = competition.room.explanationsEnabled === false
    ? `Bonne reponse : ${result.correctAnswer}.`
    : `${result.explanation} Bonne reponse : ${result.correctAnswer}.`;
  $('#competitionReference').textContent = result.reference ? `Reference : ${result.reference}` : '';
  $('#competitionFeedback').classList.remove('hidden');
  $('#competitionNext').textContent = competition.index + 1 >= competition.questions.length ? 'Resultat du tour' : 'Question suivante';
  renderRoomLeaderboard(result.leaderboard);
}

function nextCompetitionQuestion() {
  competition.index += 1;
  if (competition.index >= competition.questions.length) {
    finishCompetitionRound();
    return;
  }
  renderCompetitionQuestion();
}

function finishCompetitionRound() {
  clearInterval(competition.timerId);
  $('#competitionBoard').classList.add('hidden');
  $('#competitionResults').classList.remove('hidden');
  $('#competitionResults').innerHTML = `
    <p class="eyebrow">Classement final</p>
    <h2>${competition.score} points</h2>
    <p>La partie est terminee. Le classement final est affiche ci-dessous.</p>
  `;
  loadRoomLeaderboard();
}

async function loadRoomLeaderboard() {
  if (!competition.room) return;
  const { leaderboard } = await api(`/api/rooms/${encodeURIComponent(competition.room.id)}/leaderboard?code=${encodeURIComponent(competition.room.accessCode)}`);
  renderRoomLeaderboard(leaderboard);
}

function renderRoomLeaderboard(leaderboard) {
  $('#roomLeaderboardRows').innerHTML = leaderboard.length ? leaderboard.map((row) => `
    <tr><td>${row.rank}</td><td>${escapeHtml(row.playerName)}</td><td><strong>${row.totalScore}</strong></td><td>${row.roundsPlayed}</td></tr>
  `).join('') : '<tr><td colspan="4">Aucun participant classe.</td></tr>';
}

async function leaveCompetitionRoom() {
  if (!competition.room) return;
  const participant = competition.participant || getStoredParticipant(competition.room.id);
  if (!participant) return;
  if (!confirm('Voulez-vous vraiment quitter la partie ?')) return;
  await api(`/api/rooms/${encodeURIComponent(competition.room.id)}/leave?code=${encodeURIComponent(competition.room.accessCode)}`, {
    method: 'POST',
    body: { participantId: participant.id || participant }
  });
  const known = JSON.parse(localStorage.getItem('quizBibleParticipants') || '{}');
  delete known[competition.room.id];
  localStorage.setItem('quizBibleParticipants', JSON.stringify(known));
  localStorage.removeItem('quizBibleCurrentRoomCode');
  localStorage.removeItem('quizBibleCurrentRoomId');
  stopCompetitionPolling();
  setCompetitionImmersive(false);
  competition.participant = null;
  competition.room = null;
  competition.round = null;
  competition.lastState = null;
  $('#roomPanel').classList.add('hidden');
  await loadRooms();
  showView('competition');
  setRoomActionMessage('Vous avez quitte la partie.', true);
}

function getStoredParticipant(roomId) {
  const known = JSON.parse(localStorage.getItem('quizBibleParticipants') || '{}');
  return known[roomId] || null;
}

async function copyRoomLink() {
  if (!competition.room) return;
  const link = `${location.origin}/#competition/${competition.room.accessCode}`;
  await navigator.clipboard?.writeText(link);
  alert(`Lien du salon : ${link}`);
}

async function adminLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: { username: form.get('username'), password: form.get('password') }
    });
    $('#adminLogin').classList.add('hidden');
    $('#adminPanel').classList.remove('hidden');
    await loadAdmin();
  } catch (error) {
    alert(error.message);
  }
}

async function adminLogout() {
  await api('/api/admin/logout', { method: 'POST', body: {} });
  $('#adminPanel').classList.add('hidden');
  $('#adminLogin').classList.remove('hidden');
}

async function loadAdmin() {
  const data = await api('/api/admin/dashboard');
  $('#adminQuestions').innerHTML = data.questions.map((question) => `
    <article class="admin-item">
      <strong>${escapeHtml(question.question)}</strong>
      <p>${escapeHtml(question.category)} · ${escapeHtml(question.level)} · ${question.isActive ? 'active' : 'inactive'}</p>
      <p>${escapeHtml(question.reference || '')}</p>
      <div class="admin-item-actions">
        <button class="secondary" data-edit="${escapeHtml(question.id)}">Modifier</button>
        <button class="secondary" data-toggle="${escapeHtml(question.id)}">${question.isActive ? 'Desactiver' : 'Activer'}</button>
        <button class="secondary" data-delete="${escapeHtml(question.id)}">Supprimer</button>
      </div>
    </article>
  `).join('');
  $('#adminChallenges').innerHTML = data.challenges.map((challenge) => `
    <article class="admin-item">
      <strong>${escapeHtml(challenge.title)}</strong>
      <p>${escapeHtml(challenge.category)} · ${escapeHtml(challenge.level)} · ${challenge.days} jours</p>
      <div class="admin-item-actions">
        <button class="secondary" data-edit-challenge="${escapeHtml(challenge.id)}">Modifier</button>
        <button class="secondary" data-delete-challenge="${escapeHtml(challenge.id)}">Supprimer</button>
      </div>
    </article>
  `).join('');
  $('#adminStats').innerHTML = `
    <p><strong>${data.sessions.length}</strong> parties jouees</p>
    <p><strong>${data.leaderboard.length}</strong> scores enregistres</p>
    <p><strong>${data.challenges.length}</strong> challenges</p>
  `;
  $('#adminRooms').innerHTML = data.rooms.map((room) => `
    <article class="admin-item">
      <strong>${escapeHtml(room.name)}</strong>
      <p>${escapeHtml(room.status)} · ${escapeHtml(room.category)} · ${escapeHtml(room.difficulty)} · ${room.participantCount} participants</p>
      <div class="admin-item-actions">
        <button class="secondary" data-admin-room-close="${escapeHtml(room.id)}">Fermer</button>
        <button class="secondary" data-admin-room-regen="${escapeHtml(room.id)}">Relancer IA</button>
        <button class="secondary" data-admin-room-delete="${escapeHtml(room.id)}">Supprimer</button>
      </div>
    </article>
  `).join('') || '<p>Aucun salon.</p>';
  $('#adminAi').innerHTML = `
    <p><strong>${data.roundQuestions.length}</strong> questions de tours generees ou fallback.</p>
    <p><strong>${data.aiErrors.length}</strong> erreurs Azure OpenAI.</p>
    ${data.aiErrors.slice(-5).reverse().map((error) => `<article class="admin-item"><strong>${escapeHtml(error.scope)}</strong><p>${escapeHtml(error.message)}</p></article>`).join('')}
  `;
  $$('[data-edit]').forEach((button) => button.addEventListener('click', () => editQuestion(data.questions.find((q) => q.id === button.dataset.edit))));
  $$('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteQuestion(button.dataset.delete)));
  $$('[data-toggle]').forEach((button) => button.addEventListener('click', () => toggleQuestion(data.questions.find((q) => q.id === button.dataset.toggle))));
  $$('[data-edit-challenge]').forEach((button) => button.addEventListener('click', () => editChallenge(data.challenges.find((c) => c.id === button.dataset.editChallenge))));
  $$('[data-delete-challenge]').forEach((button) => button.addEventListener('click', () => deleteChallenge(button.dataset.deleteChallenge)));
  $$('[data-admin-room-close]').forEach((button) => button.addEventListener('click', () => adminCloseRoom(button.dataset.adminRoomClose)));
  $$('[data-admin-room-delete]').forEach((button) => button.addEventListener('click', () => adminDeleteRoom(button.dataset.adminRoomDelete)));
  $$('[data-admin-room-regen]').forEach((button) => button.addEventListener('click', () => adminRegenerateRoom(button.dataset.adminRoomRegen)));
}

async function addQuestion(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get('id');
  await api(id ? `/api/admin/questions/${encodeURIComponent(id)}` : '/api/admin/questions', {
    method: id ? 'PUT' : 'POST',
    body: {
      id,
      question: form.get('question'),
      options: String(form.get('options')).split('|').map((item) => item.trim()),
      correctAnswer: form.get('correctAnswer'),
      explanation: form.get('explanation'),
      reference: form.get('reference'),
      category: form.get('category'),
      level: form.get('level'),
      type: form.get('type'),
      isActive: form.get('isActive') === 'on'
    }
  });
  resetQuestionEditor();
  await loadAdmin();
}

async function addChallenge(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get('id');
  await api(id ? `/api/admin/challenges/${encodeURIComponent(id)}` : '/api/admin/challenges', {
    method: id ? 'PUT' : 'POST',
    body: Object.fromEntries(form.entries())
  });
  resetChallengeEditor();
  await Promise.all([loadAdmin(), loadChallenges()]);
}

async function deleteQuestion(id) {
  await api(`/api/admin/questions/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
  await loadAdmin();
}

async function deleteChallenge(id) {
  await api(`/api/admin/challenges/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
  await Promise.all([loadAdmin(), loadChallenges()]);
}

async function toggleQuestion(question) {
  await api(`/api/admin/questions/${encodeURIComponent(question.id)}`, {
    method: 'PUT',
    body: { ...question, isActive: !question.isActive }
  });
  await loadAdmin();
}

function editQuestion(question) {
  const form = $('#questionEditor');
  form.elements.id.value = question.id;
  form.elements.question.value = question.question;
  form.elements.options.value = question.options.join(' | ');
  form.elements.correctAnswer.value = question.correctAnswer;
  form.elements.explanation.value = question.explanation;
  form.elements.reference.value = question.reference || '';
  form.elements.category.value = question.category;
  form.elements.level.value = question.level;
  form.elements.type.value = question.type;
  form.elements.isActive.checked = question.isActive !== false;
  $('#questionEditorTitle').textContent = 'Modifier la question';
  $('#questionSubmit').textContent = 'Enregistrer';
  $('#questionCancel').classList.remove('hidden');
}

function editChallenge(challenge) {
  const form = $('#challengeEditor');
  form.elements.id.value = challenge.id;
  form.elements.title.value = challenge.title;
  form.elements.description.value = challenge.description;
  form.elements.summary.value = challenge.summary || '';
  form.elements.category.value = challenge.category;
  form.elements.level.value = challenge.level;
  form.elements.days.value = challenge.days || 7;
  $('#challengeEditorTitle').textContent = 'Modifier le challenge';
  $('#challengeSubmit').textContent = 'Enregistrer';
  $('#challengeCancel').classList.remove('hidden');
}

function resetQuestionEditor() {
  $('#questionEditor').reset();
  $('#questionEditor').elements.isActive.checked = true;
  $('#questionEditorTitle').textContent = 'Ajouter une question';
  $('#questionSubmit').textContent = 'Ajouter';
  $('#questionCancel').classList.add('hidden');
}

function resetChallengeEditor() {
  $('#challengeEditor').reset();
  $('#challengeEditorTitle').textContent = 'Ajouter un challenge';
  $('#challengeSubmit').textContent = 'Ajouter';
  $('#challengeCancel').classList.add('hidden');
}

async function adminGenerate() {
  const category = $('#adminCategorySelect').value;
  const level = $('#adminLevelSelect').value;
  await api('/api/admin/generate-questions', {
    method: 'POST',
    body: { category, level, count: 20, questionTypes: ['qcm', 'vrai_faux', 'personnage'] }
  });
  await loadAdmin();
}

async function adminCloseRoom(id) {
  await api(`/api/admin/rooms/${encodeURIComponent(id)}/close`, { method: 'POST', body: {} });
  await loadAdmin();
}

async function adminDeleteRoom(id) {
  await api(`/api/admin/rooms/${encodeURIComponent(id)}/delete`, { method: 'DELETE', body: {} });
  await loadAdmin();
}

async function adminRegenerateRoom(id) {
  await api(`/api/admin/rooms/${encodeURIComponent(id)}/regenerate`, { method: 'POST', body: {} });
  await loadAdmin();
}

function cryptoRandom() {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16)).join('');
}

function toggleTheme() {
  document.body.classList.toggle('dark');
  localStorage.setItem('quizBibleTheme', document.body.classList.contains('dark') ? 'dark' : 'light');
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Erreur reseau');
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}

function renderCompetitionState(data) {
  if (!data?.room) return;
  competition.lastState = data;
  competition.room = data.room;
  competition.participant = data.participant;
  competition.round = data.round;
  setCompetitionImmersive(['starting', 'question_active', 'question_reveal', 'between_questions'].includes(data.phase));
  const room = data.room;
  $('#roomPanel').classList.remove('hidden');
  $('#roomStatus').textContent = `${labelPhase(data.phase || room.status)} - ${room.difficulty}`;
  $('#roomTitle').textContent = room.name;
  $('#roomDescription').textContent = room.description || 'En attente des amis. Partagez le code puis lancez la partie.';
  $('#roomParticipants').textContent = data.participants?.length || room.participantCount || room.participants?.length || 0;
  $('#roomRounds').textContent = room.roundCount || room.rounds?.length || 0;
  $('#roomCode').textContent = room.accessCode;
  $('#roomRoundsHistory').innerHTML = (room.rounds || []).map((round) => `
    <article class="admin-item">
      <strong>Partie ${round.roundNumber} - ${escapeHtml(round.phase || round.status)}</strong>
      <p>${new Date(round.startsAt).toLocaleString('fr-FR')} - ${new Date(round.endsAt).toLocaleString('fr-FR')}</p>
      <p>IA: ${round.generatedByAI ? 'oui' : 'fallback local'} - validation: ${escapeHtml(round.validationStatus)}</p>
    </article>
  `).join('') || '<p>Aucun tour.</p>';
  renderRoomLeaderboard(data.leaderboard || []);
  renderPhase(data);
}

function renderPhase(data) {
  const phase = data.phase || 'waiting';
  const question = data.currentQuestion;
  $('#competitionScore').textContent = `${data.score || 0} pts`;
  $('#competitionCounter').textContent = data.totalQuestions ? `Question ${data.questionIndex + 1}/${data.totalQuestions}` : 'En attente';
  $('#competitionTimer').textContent = `${data.countdownSeconds || 0}s`;
  $('#competitionTimerBar').style.width = data.room?.questionTimeLimit
    ? `${Math.max(0, Math.min(100, (data.timeRemainingMs / (data.room.questionTimeLimit * 1000)) * 100))}%`
    : '0%';

  if (phase === 'waiting') {
    $('#competitionBoard').classList.add('hidden');
    $('#competitionResults').classList.remove('hidden');
    $('#competitionResults').innerHTML = '<p class="eyebrow">Salle d attente</p><h2>Partagez le code</h2><p>La partie commencera quand le createur cliquera sur Lancer la partie.</p>';
    return;
  }
  if (phase === 'starting') {
    $('#competitionBoard').classList.add('hidden');
    $('#competitionResults').classList.remove('hidden');
    $('#competitionResults').innerHTML = `<p class="eyebrow">Lancement</p><h2>Depart dans ${data.countdownSeconds || 1}s</h2>`;
    return;
  }
  if (phase === 'finished') {
    $('#competitionBoard').classList.add('hidden');
    $('#competitionResults').classList.remove('hidden');
    $('#competitionResults').innerHTML = '<p class="eyebrow">Classement final</p><h2>Partie terminee</h2><p>Le classement final est affiche ci-dessous.</p>';
    return;
  }
  if (!question) return;

  $('#competitionResults').classList.add('hidden');
  $('#competitionBoard').classList.remove('hidden');
  $('#competitionType').textContent = question.type.replaceAll('_', ' ');
  $('#competitionQuestion').textContent = question.question;
  $('#competitionAnswers').innerHTML = question.options.map((option) => {
    const selected = data.currentAnswer?.selectedAnswer === option;
    const correct = question.correctAnswer && question.correctAnswer === option;
    const wrong = selected && question.correctAnswer && question.correctAnswer !== option;
    return `<button class="answer ${selected ? 'selected' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}" type="button" ${phase !== 'question_active' ? 'disabled' : ''}>${escapeHtml(option)}</button>`;
  }).join('');
  if (phase === 'question_active') {
    $$('#competitionAnswers .answer').forEach((button) => button.addEventListener('click', () => submitCompetitionAnswer(button, button.textContent)));
  }
  $('#competitionFeedback').classList.remove('hidden');
  $('#competitionNext').classList.add('hidden');
  if (phase === 'question_active') {
    $('#competitionFeedbackTitle').textContent = data.currentAnswer ? 'Reponse selectionnee' : 'A vous de jouer';
    $('#competitionFeedbackText').textContent = data.currentAnswer ? 'Reponse selectionnee — tu peux changer avant la fin du chrono.' : 'Repondez avant la fin du chrono.';
    $('#competitionReference').textContent = '';
    return;
  }
  if (phase === 'question_reveal' || phase === 'between_questions') {
    const currentPoints = Number(data.currentAnswer?.totalPoints || 0);
    const leaderboard = renderInlineLeaderboard(data.leaderboard || []);
    $('#competitionFeedbackTitle').textContent = `Bonne reponse : ${question.correctAnswer}`;
    $('#competitionFeedbackText').innerHTML = `
      <span>${escapeHtml(question.explanation || 'Explication indisponible.')}</span>
      <strong>Points gagnes : ${currentPoints}</strong>
      <span>Prochaine question dans ${data.countdownSeconds || 0}...</span>
      ${leaderboard}
    `;
    $('#competitionReference').textContent = question.reference ? `Reference : ${question.reference}` : '';
  }
}

async function startCompetitionRound(event) {
  if (!competition.room) return;
  const button = event?.currentTarget || $('#startRound');
  setButtonLoading(button, true);
  setRoomActionMessage('Lancement de la partie...', true);
  try {
    const creatorId = localStorage.getItem('quizBibleCreatorId') || '';
    const participantId = competition.participant?.id || getStoredParticipant(competition.room.id);
    const data = await api(`/api/rooms/${encodeURIComponent(competition.room.id)}/start-round?code=${encodeURIComponent(competition.room.accessCode)}`, {
      method: 'POST',
      body: { creatorId, participantId }
    });
    renderCompetitionState(data);
    startCompetitionPolling();
    setRoomActionMessage('Partie lancee.', true);
  } catch (error) {
    console.error('startCompetitionRound failed', error);
    setRoomActionMessage(error.message || 'Lancement impossible.');
  } finally {
    setButtonLoading(button, false);
  }
}

async function submitCompetitionAnswer(button, selectedAnswer) {
  if (!competition.round || !competition.lastState?.currentQuestion) return;
  $$('#competitionAnswers .answer').forEach((answerButton) => answerButton.classList.toggle('selected', answerButton === button));
  $('#competitionFeedback').classList.remove('hidden');
  $('#competitionFeedbackTitle').textContent = 'Reponse selectionnee';
  $('#competitionFeedbackText').textContent = 'Reponse selectionnee — tu peux changer avant la fin du chrono.';
  $('#competitionReference').textContent = '';
  setButtonLoading(button, true);
  try {
    const participant = competition.participant || getStoredParticipant(competition.room.id);
    const result = await api(`/api/rounds/${encodeURIComponent(competition.round.id)}/answer`, {
      method: 'POST',
      body: { participantId: participant.id || participant, questionId: competition.lastState.currentQuestion.id, selectedAnswer }
    });
    renderCompetitionState(result.state);
  } catch (error) {
    console.error('submitCompetitionAnswer failed', error);
    setRoomActionMessage(error.message || 'Reponse non enregistree.');
    await loadCompetitionState();
  } finally {
    setButtonLoading(button, false);
  }
}

function nextCompetitionQuestion() {
  loadCompetitionState().catch((error) => console.error('manual state refresh failed', error));
}

async function loadRoomLeaderboard() {
  if (!competition.room) return;
  await loadCompetitionState();
}

async function loadCompetitionState() {
  if (!competition.room) return;
  const participantId = competition.participant?.id || getStoredParticipant(competition.room.id) || '';
  const data = await api(`/api/rooms/${encodeURIComponent(competition.room.accessCode || competition.room.id)}/state?participantId=${encodeURIComponent(participantId)}&code=${encodeURIComponent(competition.room.accessCode || '')}`);
  renderCompetitionState(data);
}

function setCompetitionImmersive(active) {
  if (active && !$('#competitionView')?.classList.contains('active')) showView('competition');
  document.body.classList.toggle('competition-immersive', active);
}

function renderInlineLeaderboard(leaderboard) {
  if (!leaderboard.length) return '<div class="mini-leaderboard"><strong>Classement provisoire</strong><span>Aucun score pour le moment.</span></div>';
  return `
    <div class="mini-leaderboard">
      <strong>Classement provisoire</strong>
      ${leaderboard.slice(0, 5).map((row) => `<span>${row.rank}. ${escapeHtml(row.playerName)} - ${Number(row.totalScore || 0)} pts</span>`).join('')}
    </div>
  `;
}

function startCompetitionPolling() {
  stopCompetitionPolling();
  competition.pollId = setInterval(() => {
    loadCompetitionState().catch((error) => {
      console.error('competition polling failed', error);
      setRoomActionMessage('Synchronisation interrompue. Nouvelle tentative...');
    });
  }, 1000);
}

function stopCompetitionPolling() {
  if (competition.pollId) clearInterval(competition.pollId);
  competition.pollId = null;
}

function persistRoom(room) {
  if (!room) return;
  localStorage.setItem('quizBibleCurrentRoomCode', room.accessCode || room.id);
  localStorage.setItem('quizBibleCurrentRoomId', room.id);
}

async function restoreCompetitionSession() {
  const code = localStorage.getItem('quizBibleCurrentRoomCode');
  if (!code) return;
  try {
    const { room } = await api(`/api/rooms/${encodeURIComponent(code)}`);
    competition.room = room;
    const participantId = getStoredParticipant(room.id);
    if (participantId) {
      const stateData = await api(`/api/rooms/${encodeURIComponent(room.accessCode)}/state?participantId=${encodeURIComponent(participantId)}&code=${encodeURIComponent(room.accessCode)}`);
      renderCompetitionState(stateData);
      startCompetitionPolling();
    }
  } catch (error) {
    console.warn('restoreCompetitionSession failed', error);
  }
}

function setButtonLoading(button, loading) {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = '...';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function setRoomMessage(message, ok = false) {
  $('#roomFormMessage').textContent = message || '';
  $('#roomFormMessage').classList.toggle('ok', ok);
}

function setRoomActionMessage(message, ok = false) {
  $('#roomActionMessage').textContent = message || '';
  $('#roomActionMessage').classList.toggle('ok', ok);
}

function resetQuickRoomDefaults() {
  $('#roomCreateForm').elements.name.value = 'Quiz entre amis';
  $('#roomCreateForm').elements.questionsPerRound.value = 10;
  $('#roomCreateForm').elements.questionTimeLimit.value = 30;
  $('#roomCreateForm').elements.roundTimeLimit.value = 30;
  $('#roomCategorySelect').value = 'random';
  $('#roomLevelSelect').value = 'intermediaire';
}

function labelPhase(phase) {
  return {
    waiting: 'Salle d attente',
    starting: 'Lancement',
    question_active: 'Question en cours',
    question_reveal: 'Correction',
    between_questions: 'Prochaine question',
    finished: 'Termine',
    closed: 'Ferme'
  }[phase] || phase;
}

if (localStorage.getItem('quizBibleTheme') === 'dark') {
  document.body.classList.add('dark');
}
