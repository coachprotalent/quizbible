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
  questionStartedAt: 0,
  remaining: 30
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
  $$('.stepper button').forEach((button) => button.addEventListener('click', stepNumberInput));
}

function fillSelects() {
  const categoryOptions = state.meta.categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`).join('');
  const levelOptions = state.meta.levels.map((level) => `<option value="${escapeHtml(level.id)}">${escapeHtml(level.label)}</option>`).join('');
  const typeOptions = state.meta.questionTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
  ['#categorySelect', '#adminCategorySelect', '#challengeCategorySelect', '#roomCategorySelect'].forEach((selector) => $(selector).innerHTML = categoryOptions);
  ['#levelSelect', '#adminLevelSelect', '#challengeLevelSelect', '#roomLevelSelect'].forEach((selector) => $(selector).innerHTML = levelOptions);
  $('#adminTypeSelect').innerHTML = typeOptions;
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
  const form = new FormData(event.currentTarget);
  const startDate = form.get('startDate') ? new Date(form.get('startDate')) : new Date();
  const duration = form.get('durationDays');
  const endDate = duration === 'custom' && form.get('endDate')
    ? new Date(form.get('endDate'))
    : new Date(startDate.getTime() + Number(duration || 7) * 24 * 60 * 60 * 1000);
  const creatorId = localStorage.getItem('quizBibleCreatorId') || `creator-${cryptoRandom()}`;
  localStorage.setItem('quizBibleCreatorId', creatorId);
  const { room } = await api('/api/rooms', {
    method: 'POST',
    body: {
      name: form.get('name'),
      description: form.get('description'),
      category: form.get('category'),
      difficulty: form.get('difficulty'),
      creatorId,
      accessCode: form.get('accessCode'),
      isPublic: form.get('isPublic') === 'on',
      questionMode: form.get('questionMode') === 'on' ? 'personalized' : 'same',
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      questionTimeLimit: Number(form.get('questionTimeLimit')),
      roundTimeLimit: Number(form.get('roundTimeLimit')),
      questionsPerRound: Number(form.get('questionsPerRound'))
    }
  });
  event.currentTarget.reset();
  await loadRooms();
  await openRoom(room.id);
}

async function joinRoomByCode(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const code = String(form.get('code')).trim().split('/').filter(Boolean).pop();
  await joinRoom(code, form.get('playerName'));
}

async function openRoom(roomId) {
  const { room } = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
  competition.room = room;
  renderRoom();
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
  competition.room = response.room;
  competition.participant = response.participant;
  renderRoom();
  await refreshCurrentRound();
}

function renderRoom() {
  const room = competition.room;
  if (!room) return;
  $('#roomPanel').classList.remove('hidden');
  $('#roomStatus').textContent = `${room.status} · ${room.difficulty}`;
  $('#roomTitle').textContent = room.name;
  $('#roomDescription').textContent = room.description || 'Salon de competition biblique.';
  $('#roomParticipants').textContent = room.participantCount || room.participants?.length || 0;
  $('#roomRounds').textContent = room.roundCount || room.rounds?.length || 0;
  $('#roomCode').textContent = room.accessCode;
  $('#roomRoundsHistory').innerHTML = (room.rounds || []).map((round) => `
    <article class="admin-item">
      <strong>Tour ${round.roundNumber} · ${round.status}</strong>
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
  $('#competitionFeedbackText').textContent = `${result.explanation} Bonne reponse : ${result.correctAnswer}.`;
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
    <p class="eyebrow">Tour termine</p>
    <h2>${competition.score} points</h2>
    <p>Le classement du salon est mis a jour apres chaque reponse.</p>
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
  await api(`/api/rooms/${encodeURIComponent(competition.room.id)}/leave?code=${encodeURIComponent(competition.room.accessCode)}`, {
    method: 'POST',
    body: { participantId: participant.id || participant }
  });
  competition.participant = null;
  await openRoom(competition.room.id);
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

if (localStorage.getItem('quizBibleTheme') === 'dark') {
  document.body.classList.add('dark');
}
