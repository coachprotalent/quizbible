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
  remaining: 30,
  gameSessionId: ''
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
  phaseTimeoutId: null,
  countdownId: null,
  phaseRefreshKey: null,
  questionStartedAt: 0,
  remaining: 30,
  lastState: null,
  spokenQuestionKey: ''
};

let questionBanks = [];
let operatorBanks = [];
let operatorChallenges = [];
let operatorTargetType = 'bank';
let operatorTargetId = '';
let isMobileMenuOpen = false;
let pendingProtectedView = '';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

init();

async function init() {
  bindNavigation();
  bindForms();
  await syncNavigationRole();
  $('#themeToggle').addEventListener('click', toggleTheme);
  state.meta = await api('/api/meta');
  fillSelects();
  await Promise.all([loadChallenges(), loadLeaderboard(), loadRooms(), loadQuestionBanks()]);
  const redirect = new URLSearchParams(location.search).get('redirect');
  if (redirect === '/admin' || redirect === 'admin') pendingProtectedView = 'admin';
  if (redirect === '/operator' || redirect === 'operator') pendingProtectedView = 'operator';
  handleInitialHash();
  restoreCompetitionSession();
  if (location.pathname === '/admin') showView('admin');
  if (location.pathname === '/operator') showView('operator');
  if (location.pathname === '/login') showView('login');
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
  $('#menuToggle')?.addEventListener('click', toggleMobileMenu);
  $('#mobileMenuClose')?.addEventListener('click', closeMobileMenu);
  $('#mobileMenuOverlay')?.addEventListener('click', closeMobileMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMobileMenu();
    }
  });
  $$('[data-view]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      showView(trigger.dataset.view);
      closeMobileMenu();
      focusViewTarget(trigger.dataset.focusTarget);
    });
  });
}

function showView(view) {
  setGameImmersive(false);
  if (view !== 'competition') setCompetitionImmersive(false);
  $$('.view').forEach((section) => section.classList.remove('active'));
  $$('.nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $(`#${view}View`)?.classList.add('active');
  document.body.classList.toggle('internal-view', view !== 'home');
  location.hash = view;
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'challenges') loadChallenges();
  if (view === 'competition') loadRooms();
  if (view === 'admin' || view === 'operator') handleProtectedView(view);
}

function toggleMobileMenu() {
  setMobileMenuOpen(!isMobileMenuOpen);
}

function closeMobileMenu() {
  setMobileMenuOpen(false);
}

function setMobileMenuOpen(open) {
  isMobileMenuOpen = Boolean(open);
  document.body.classList.toggle('menu-open', isMobileMenuOpen);
  $('#menuToggle')?.setAttribute('aria-expanded', String(isMobileMenuOpen));
  $('#menuToggle')?.setAttribute('aria-label', isMobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu');
  const overlay = $('#mobileMenuOverlay');
  if (overlay) overlay.hidden = !isMobileMenuOpen;
}

function focusViewTarget(id) {
  if (!id) return;
  requestAnimationFrame(() => {
    const target = document.getElementById(id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.querySelector('input, select, textarea, button')?.focus?.({ preventScroll: true });
  });
}

async function syncNavigationRole() {
  try {
    await api('/api/auth/me');
  } catch (error) {
    // Navigation entries stay visible; access is enforced when a protected view opens.
  }
}

function bindForms() {
  $('#gameSetup').addEventListener('submit', startGame);
  $('#nextQuestion').addEventListener('click', nextQuestion);
  $('#quitGame').addEventListener('click', quitGame);
  $('#adminLogin').addEventListener('submit', adminLogin);
  $('#loginForm').addEventListener('submit', loginUserForm);
  $('#adminLogout').addEventListener('click', adminLogout);
  $('#adminRefresh').addEventListener('click', loadAdmin);
  $('#adminUserEditor').addEventListener('submit', adminCreateUser);
  $('#challengeEditor').addEventListener('submit', addChallenge);
  $('#bankEditor').addEventListener('submit', addQuestionBank);
  $('#operatorLogin').addEventListener('submit', operatorLogin);
  $('#operatorLogout').addEventListener('click', operatorLogout);
  $('#operatorRefresh').addEventListener('click', loadOperator);
  $('#operatorManualQuestion').addEventListener('submit', operatorAddManualQuestion);
  $('#operatorGenerateTheme').addEventListener('submit', operatorGenerateQuestions);
  $('#operatorGenerateText').addEventListener('submit', operatorGenerateQuestions);
  $('#challengeCancel').addEventListener('click', resetChallengeEditor);
  $('#roomCreateForm').addEventListener('submit', createRoom);
  $('#championSetup').addEventListener('submit', createChampionRoom);
  $('#roomJoinForm').addEventListener('submit', joinRoomByCode);
  $('#startRound').addEventListener('click', startCompetitionRound);
  $('#leaveRoom').addEventListener('click', leaveCompetitionRoom);
  $('#copyRoomLink').addEventListener('click', copyRoomLink);
  $('#competitionNext').addEventListener('click', nextCompetitionQuestion);
  $('#advancedToggle').addEventListener('click', () => $('#advancedOptions').classList.toggle('hidden'));
  $('#roomQuestionSource').addEventListener('change', updateQuestionBankVisibility);
  $('#championQuestionSource').addEventListener('change', updateQuestionBankVisibility);
  $('#roomIsScheduled').addEventListener('change', updateScheduleVisibility);
  ['#levelSelect', '#roomLevelSelect', '#championLevelSelect', '#challengeLevelSelect', '#bankLevelSelect', '#operatorManualLevel', '#operatorThemeLevel', '#operatorTextLevel']
    .forEach((selector) => $(selector)?.addEventListener('change', updateScholarNotices));
  $$('input[name="championEdition"]').forEach((input) => input.addEventListener('change', updateChampionEdition));
  $$('.stepper button').forEach((button) => button.addEventListener('click', stepNumberInput));
}

function fillSelects() {
  const categoryOptions = state.meta.categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`).join('');
  const levelOptions = state.meta.levels.map((level) => {
    const label = level.id === 'scholar' ? 'Scholar - etude avancee' : level.label;
    return `<option value="${escapeHtml(level.id)}">${escapeHtml(label)}</option>`;
  }).join('');
  const typeOptions = state.meta.questionTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
  ['#categorySelect', '#challengeCategorySelect', '#roomCategorySelect', '#championCategorySelect', '#operatorThemeCategory'].forEach((selector) => $(selector).innerHTML = categoryOptions);
  ['#levelSelect', '#challengeLevelSelect', '#roomLevelSelect', '#championLevelSelect', '#operatorManualLevel', '#operatorThemeLevel', '#operatorTextLevel'].forEach((selector) => $(selector).innerHTML = levelOptions);
  $('#bankCategorySelect').innerHTML = categoryOptions;
  $('#bankLevelSelect').innerHTML = levelOptions;
  $('#operatorManualType').innerHTML = typeOptions;
  $('#operatorThemeType').innerHTML = typeOptions;
  $('#operatorTextType').innerHTML = typeOptions;
  $('#roomQuestionTypes').innerHTML = typeOptions;
  $('#roomCategorySelect').value = 'random';
  $('#roomLevelSelect').value = 'intermediaire';
  $('#championCategorySelect').value = 'random';
  $('#championLevelSelect').value = 'intermediaire';
  updateScholarNotices();
  updateChampionEdition();
}

function updateScholarNotices() {
  const scholarSelects = ['#levelSelect', '#roomLevelSelect', '#championLevelSelect', '#challengeLevelSelect', '#bankLevelSelect', '#operatorManualLevel', '#operatorThemeLevel', '#operatorTextLevel'];
  scholarSelects.forEach((selector) => {
    const select = $(selector);
    if (!select) return;
    select.classList.toggle('scholar-select', select.value === 'scholar');
  });
  $('#scholarNotice')?.classList.toggle('hidden', $('#levelSelect')?.value !== 'scholar');
  $('#roomScholarNotice')?.classList.toggle('hidden', $('#roomLevelSelect')?.value !== 'scholar');
}

function updateChampionEdition() {
  const edition = document.querySelector('input[name="championEdition"]:checked')?.value || 'solo';
  if ($('#championLevelSelect') && edition === 'scholar') $('#championLevelSelect').value = 'scholar';
  updateScholarNotices();
}

function stepNumberInput(event) {
  const button = event.currentTarget;
  const input = button.closest('.stepper').querySelector(`input[name="${button.dataset.target}"]`);
  const min = Number(input.min || 0);
  const max = Number(input.max || 999);
  const next = Number(input.value || 0) + Number(button.dataset.step || 1);
  input.value = Math.max(min, Math.min(max, next));
}

function recentLocalQuestionHistory(playerName, level) {
  try {
    const key = localHistoryKey(playerName);
    const all = JSON.parse(localStorage.getItem('qb_recent_questions') || '[]');
    return all
      .filter((item) => item.playerKey === key && Math.abs(levelRank(item.level) - levelRank(level)) <= 1)
      .slice(-50)
      .map((item) => ({ question: item.question, correctAnswer: item.correctAnswer, level: item.level }));
  } catch {
    return [];
  }
}

function recordLocalQuestionHistory(playerName, level, questions) {
  try {
    const key = localHistoryKey(playerName);
    const existing = JSON.parse(localStorage.getItem('qb_recent_questions') || '[]')
      .filter((item) => item.playerKey !== key)
      .concat(JSON.parse(localStorage.getItem('qb_recent_questions') || '[]').filter((item) => item.playerKey === key).slice(-80));
    const additions = questions.map((question) => ({
      playerKey: key,
      level,
      question: question.question,
      correctAnswer: question.correctAnswer || '',
      playedAt: new Date().toISOString()
    }));
    localStorage.setItem('qb_recent_questions', JSON.stringify(existing.concat(additions).slice(-500)));
  } catch {
    // Local history is an optimization; server-side history still protects the session.
  }
}

function localHistoryKey(playerName) {
  return String(playerName || 'Anonyme').trim().toLowerCase() || 'anonyme';
}

function levelRank(level) {
  const normalized = String(level || '').toLowerCase();
  return { debutant: 1, beginner: 1, intermediaire: 2, intermediate: 2, avance: 3, advanced: 3, expert: 4, scholar: 5 }[normalized] || 1;
}

async function startGame(event) {
  event.preventDefault();
  const submit = event.submitter;
  const form = new FormData(event.currentTarget);
  state.playerName = form.get('playerName') || 'Anonyme';
  state.category = form.get('category');
  state.level = form.get('level');
  state.timeLimit = Number(form.get('timeLimit'));
  state.currentIndex = 0;
  state.score = 0;
  state.answers = [];
  setGameImmersive(true);
  window.scrollTo({ top: 0, left: 0 });
  $('#gameBoard').classList.add('hidden');
  $('#results').classList.add('hidden');
  renderSoloPreparation();
  setButtonLoading(submit, true);
  try {
    const response = await api('/api/start-game', {
      method: 'POST',
      body: {
        category: state.category,
        level: state.level,
        count: Number(form.get('count')),
        playerName: state.playerName,
        recentQuestions: recentLocalQuestionHistory(state.playerName, state.level)
      }
    });
    state.gameSessionId = response.gameSessionId || '';
    state.questions = response.questions;
    await runSoloCountdown();
    state.startedAt = Date.now();
    $('#results').classList.add('hidden');
    $('#gameBoard').classList.remove('hidden');
    renderQuestion();
  } catch (error) {
    $('#results').classList.remove('hidden');
    $('#results').innerHTML = `<p class="eyebrow">Erreur</p><h2>Preparation impossible</h2><p>${escapeHtml(error.message || 'Impossible de preparer les questions.')}</p>`;
  } finally {
    setButtonLoading(submit, false);
  }
}

function renderSoloPreparation() {
  $('#results').classList.remove('hidden');
  $('#results').innerHTML = `
    <div class="loading-state">
      <span class="spinner" aria-hidden="true"></span>
      <p class="eyebrow">Preparation des questions</p>
      <h2>Nous preparons les questions bibliques pour votre partie.</h2>
      <p>L'IA peut prendre quelques secondes selon le niveau choisi.</p>
    </div>
  `;
}

function runSoloCountdown() {
  return new Promise((resolve) => {
    let count = 3;
    $('#results').classList.remove('hidden');
    const render = () => {
      $('#results').innerHTML = `<p class="eyebrow">Lancement</p><h2>La partie commence dans...</h2><strong class="countdown-number">${count}</strong>`;
    };
    render();
    const id = setInterval(() => {
      count -= 1;
      if (count <= 0) {
        clearInterval(id);
        resolve();
        return;
      }
      render();
    }, 1000);
  });
}

function quitGame() {
  if (!confirm('Voulez-vous vraiment quitter la partie ?')) return;
  clearInterval(state.timerId);
  state.questions = [];
  state.currentIndex = 0;
  state.score = 0;
  $('#gameBoard').classList.add('hidden');
  $('#results').classList.add('hidden');
  setGameImmersive(false);
  showView('play');
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
      gameSessionId: state.gameSessionId,
      answer,
      timeLeft: state.remaining,
      timeLimit: state.timeLimit
    }
  });
  state.answers.push({ questionId: question.id, gameSessionId: state.gameSessionId, answer, timeLeft: state.remaining, timeLimit: state.timeLimit });
  state.score += review.points;
  $('#score').textContent = `${state.score} pts`;
  $$('.answer').forEach((button) => {
    button.disabled = true;
    if (button.textContent === review.correctAnswer) button.classList.add('correct');
    if (answer && button.textContent === answer && !review.isCorrect) button.classList.add('wrong');
  });
  $('#feedbackTitle').textContent = review.isCorrect ? 'Bonne reponse' : 'A retenir';
  $('#feedbackText').textContent = `${review.explanation} Bonne reponse : ${review.correctAnswer}.`;
  if (review.historicalNote) $('#feedbackText').textContent += ` Note historique : ${review.historicalNote}`;
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
  setGameImmersive(false);
  const response = await api('/api/submit-game', {
    method: 'POST',
    body: {
      playerName: state.playerName,
      category: state.category,
      level: state.level,
      timeLimit: state.timeLimit,
      duration: Math.round((Date.now() - state.startedAt) / 1000),
      gameSessionId: state.gameSessionId,
      answers: state.answers
    }
  });
  recordLocalQuestionHistory(state.playerName, state.level, state.questions);
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
  const groups = [
    ['beginner', 'Debutant', 1],
    ['intermediate', 'Intermediaire', 2],
    ['advanced', 'Avance', 3],
    ['expert', 'Expert', 4],
    ['scholar', 'Scholar', 5]
  ];
  $('#leaderboardGroups').innerHTML = groups.map(([key, label, limit]) => {
    const rows = leaderboard?.[key] || [];
    return `
      <section class="leaderboard-group">
        <h3>${escapeHtml(label)} <span>Top ${limit}</span></h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rang</th>
                <th>Joueur</th>
                <th>Niveau</th>
                <th>Points</th>
                <th>% reussite</th>
                <th>Temps</th>
                <th>Score performance</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map((row) => `
                <tr>
                  <td>${row.rank}</td>
                  <td>${escapeHtml(row.playerName)}</td>
                  <td>${escapeHtml(row.level)}</td>
                  <td><strong>${Number(row.pointsObtenus || row.score || 0)}</strong></td>
                  <td>${formatPercent(row.pourcentagePoints ?? row.percent)}</td>
                  <td>${formatDurationSeconds(row.durationSeconds || row.duration || 0)}</td>
                  <td>${Number(row.scorePerformance || 0).toFixed(2)} pts/s</td>
                </tr>
              `).join('') : '<tr><td colspan="7">Aucun score pour ce niveau.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }).join('');
}

async function loadRooms() {
  const { rooms } = await api('/api/rooms');
  $('#roomsGrid').innerHTML = rooms.length ? rooms.map((room) => `
    <article class="challenge-card">
      <p class="pill">${escapeHtml(room.status)}</p>
      <h3>${escapeHtml(room.name)}</h3>
      <p>${escapeHtml(room.description || 'Competition biblique chronometree.')}</p>
      <p>${room.gameMode === 'champion' ? 'Question pour un Champion' : 'Competition'} - ${escapeHtml(room.category)} - ${escapeHtml(room.difficulty)} - ${room.questionsPerRound} questions</p>
      <p>${new Date(room.startDate).toLocaleString('fr-FR')} - ${new Date(room.endDate).toLocaleString('fr-FR')}</p>
      <button class="secondary" data-room-open="${escapeHtml(room.id)}">Ouvrir</button>
    </article>
  `).join('') : '<p>Aucun salon public actif.</p>';
  $$('[data-room-open]').forEach((button) => button.addEventListener('click', () => openRoom(button.dataset.roomOpen)));
}

async function loadQuestionBanks() {
  try {
    const data = await api('/api/question-banks');
    questionBanks = data.questionBanks || [];
    $('#roomQuestionBankSelect').innerHTML = questionBanks.length
      ? questionBanks.map((bank) => `<option value="${escapeHtml(bank.id)}">${escapeHtml(bank.title)} - ${escapeHtml(bank.difficulty)}</option>`).join('')
      : '<option value="">Aucune banque disponible</option>';
    $('#championQuestionBankSelect').innerHTML = $('#roomQuestionBankSelect').innerHTML;
    updateQuestionBankVisibility();
  } catch (error) {
    console.warn('loadQuestionBanks failed', error);
    questionBanks = [];
  }
}

function updateQuestionBankVisibility() {
  const local = $('#roomQuestionSource')?.value === 'local';
  $('#roomQuestionBankWrap')?.classList.toggle('hidden', !local);
  const championLocal = $('#championQuestionSource')?.value === 'local';
  $('#championQuestionBankWrap')?.classList.toggle('hidden', !championLocal);
}

function updateScheduleVisibility() {
  $('#roomScheduleOptions')?.classList.toggle('hidden', !$('#roomIsScheduled')?.checked);
}

async function createRoom(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  setButtonLoading(submit, true);
  setRoomMessage('Creation du salon...', true);
  const form = new FormData(formElement);
  try {
    const totalMinutes = Number(form.get('roundTimeLimit') || 30);
    const isScheduled = form.get('isScheduled') === 'on';
    const scheduledStartAt = buildScheduledStart(form);
    if (isScheduled && !scheduledStartAt) throw new Error('Choisissez une date et une heure de debut.');
    const durationMinutes = Number(form.get('durationMinutes') || totalMinutes);
    const startDate = isScheduled && scheduledStartAt ? scheduledStartAt : new Date();
    const manualEnd = form.get('scheduledEndAt') ? new Date(form.get('scheduledEndAt')) : null;
    const endDate = new Date(startDate.getTime() + totalMinutes * 60 * 1000);
    const creatorId = localStorage.getItem('quizBibleCreatorId') || `creator-${cryptoRandom()}`;
    localStorage.setItem('quizBibleCreatorId', creatorId);
    const selectedTypes = form.getAll('questionTypes');
    if (form.get('questionSource') === 'local' && !form.get('questionBankId')) {
      throw new Error('Choisissez une banque de questions locales.');
    }
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
        questionBankId: form.get('questionSource') === 'local' ? form.get('questionBankId') : '',
        startDate: startDate.toISOString(),
        endDate: (manualEnd || new Date(startDate.getTime() + durationMinutes * 60 * 1000) || endDate).toISOString(),
        isScheduled,
        scheduledStartAt: isScheduled ? startDate.toISOString() : null,
        scheduledEndAt: isScheduled ? (manualEnd || new Date(startDate.getTime() + durationMinutes * 60 * 1000)).toISOString() : null,
        durationMinutes,
        autoStart: form.get('autoStart') === 'on',
        questionTimeLimit: Number(form.get('questionTimeLimit')),
        roundTimeLimit: totalMinutes,
        questionsPerRound: Number(form.get('questionsPerRound'))
      }
    });
    await joinRoom(room.id, form.get('playerName'));
    formElement?.reset?.();
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

async function createChampionRoom(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  setButtonLoading(submit, true);
  setChampionMessage('Preparation du mode Champion...', true);
  const form = new FormData(formElement);
  const edition = form.get('championEdition') || 'solo';
  const creatorId = localStorage.getItem('quizBibleCreatorId') || `creator-${cryptoRandom()}`;
  localStorage.setItem('quizBibleCreatorId', creatorId);
  const difficulty = edition === 'scholar' ? 'scholar' : form.get('difficulty');
  if (form.get('questionSource') === 'local' && !form.get('questionBankId')) {
    setChampionMessage('Choisissez une banque de questions locales.');
    setButtonLoading(submit, false);
    return;
  }
  try {
    const { room } = await api('/api/rooms', {
      method: 'POST',
      body: {
        name: form.get('name') || 'Question pour un Champion',
        description: `Mode Champion - ${edition === 'solo' ? 'Solo' : edition === 'scholar' ? 'Scholar Edition' : 'Multijoueur humain'}`,
        category: form.get('category'),
        difficulty,
        creatorId,
        gameMode: 'champion',
        championEdition: edition,
        championVoiceEnabled: form.get('championVoiceEnabled') === 'on',
        championMusicEnabled: form.get('championMusicEnabled') === 'on',
        championFinaleMode: form.get('championFinaleMode'),
        isPublic: edition !== 'solo',
        questionMode: 'same',
        questionTypes: ['qcm', 'vrai_faux', 'personnage', 'livre_biblique', 'qui_suis_je', 'indice_progressif', 'contexte_historique'],
        explanationsEnabled: true,
        questionSource: form.get('questionSource') || 'ai',
        questionBankId: form.get('questionSource') === 'local' ? form.get('questionBankId') : '',
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
        durationMinutes: 45,
        questionTimeLimit: 12,
        roundTimeLimit: 2,
        questionsPerRound: 12
      }
    });
    await joinRoom(room.id, form.get('playerName'));
    showView('competition');
    setChampionMessage('Salon Champion pret.', true);
    setRoomActionMessage(edition === 'solo' ? 'Mode solo: lancez la premiere manche.' : 'Mode Champion cree. Partagez le code avec des joueurs humains.', true);
    await loadRooms();
  } catch (error) {
    console.error('createChampionRoom failed', error);
    setChampionMessage(error.message || 'Impossible de creer le mode Champion.');
  } finally {
    setButtonLoading(submit, false);
  }
}

function setChampionMessage(message, ok = false) {
  const target = $('#championFormMessage');
  if (!target) return;
  target.textContent = message || '';
  target.classList.toggle('ok', ok);
}

function buildScheduledStart(form) {
  const date = form.get('scheduledStartDate');
  const time = form.get('scheduledStartTime');
  if (!date || !time) return null;
  return new Date(`${date}T${time}`);
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
  $('#competitionType').textContent = data.round?.championRoundLabel || question.type.replaceAll('_', ' ');
  $('#competitionQuestion').textContent = question.question;
  renderChampionClues(data, question);
  maybeSpeakChampionQuestion(data, question);
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
  if (competition.room.explanationsEnabled !== false && result.historicalNote) {
    $('#competitionFeedbackText').textContent += ` Note historique : ${result.historicalNote}`;
  }
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
  const button = $('#leaveRoom');
  setButtonLoading(button, true);
  try {
    await api(`/api/rooms/${encodeURIComponent(competition.room.accessCode || competition.room.id)}/leave?code=${encodeURIComponent(competition.room.accessCode || '')}`, {
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
    showView('home');
    setRoomActionMessage('Vous avez quitte la partie.', true);
  } catch (error) {
    console.error('leaveCompetitionRoom failed', error);
    const message = error.message || 'Impossible de quitter la partie. Reessayez.';
    setRoomActionMessage(message);
    if (confirm(`${message}\nForcer la sortie locale ?`)) forceLocalCompetitionExit();
  } finally {
    setButtonLoading(button, false);
  }
}

function forceLocalCompetitionExit() {
  if (competition.room?.id) {
    const known = JSON.parse(localStorage.getItem('quizBibleParticipants') || '{}');
    delete known[competition.room.id];
    localStorage.setItem('quizBibleParticipants', JSON.stringify(known));
  }
  localStorage.removeItem('quizBibleCurrentRoomCode');
  localStorage.removeItem('quizBibleCurrentRoomId');
  stopCompetitionPolling();
  setCompetitionImmersive(false);
  competition.participant = null;
  competition.room = null;
  competition.round = null;
  competition.lastState = null;
  $('#roomPanel').classList.add('hidden');
  showView('home');
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
    setAccessMessage('admin', '');
    await syncNavigationRole();
    await loadAdmin();
    history.replaceState(null, '', '/admin');
  } catch (error) {
    alert(error.message);
  }
}

async function loginUserForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: form.get('email'), password: form.get('password') }
    });
    $('#loginMessage').textContent = '';
    await syncNavigationRole();
    if (pendingProtectedView) {
      const nextView = pendingProtectedView;
      pendingProtectedView = '';
      showView(nextView);
      history.replaceState(null, '', `/${nextView}`);
    } else {
      showView(user?.role === 'admin' ? 'admin' : user?.role === 'operator' ? 'operator' : 'home');
      if (!['admin', 'operator'].includes(user?.role)) alert('Acces non autorise');
    }
  } catch (error) {
    $('#loginMessage').textContent = error.message || 'Connexion impossible';
  }
}

async function adminLogout() {
  await api('/api/admin/logout', { method: 'POST', body: {} });
  $('#adminPanel').classList.add('hidden');
  $('#adminLogin').classList.remove('hidden');
  setAccessMessage('admin', '');
  await syncNavigationRole();
  history.replaceState(null, '', '/login?redirect=/admin');
}

async function operatorLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: { email: form.get('email'), password: form.get('password') }
    });
    $('#operatorLogin').classList.add('hidden');
    $('#operatorPanel').classList.remove('hidden');
    setAccessMessage('operator', '');
    await syncNavigationRole();
    await loadOperator();
    history.replaceState(null, '', '/operator');
  } catch (error) {
    alert(error.message);
  }
}

async function operatorLogout() {
  await api('/api/auth/logout', { method: 'POST', body: {} });
  $('#operatorPanel').classList.add('hidden');
  $('#operatorLogin').classList.remove('hidden');
  setAccessMessage('operator', '');
  await syncNavigationRole();
  history.replaceState(null, '', '/login?redirect=/operator');
}

async function loadOperator() {
  const [banksData, challengesData] = await Promise.all([
    api('/api/operator/question-banks'),
    api('/api/operator/challenges')
  ]);
  operatorBanks = banksData.questionBanks || [];
  operatorChallenges = challengesData.challenges || [];
  $('#operatorLogin').classList.add('hidden');
  $('#operatorPanel').classList.remove('hidden');
  setAccessMessage('operator', '');
  $('#operatorBanks').innerHTML = operatorBanks.map((bank) => `
    <article class="admin-item">
      <strong>${escapeHtml(bank.title)}</strong>
      <p>${escapeHtml(bank.category)} - ${escapeHtml(bank.difficulty)}</p>
      <button class="secondary" data-operator-target-type="bank" data-operator-target-id="${escapeHtml(bank.id)}">Ouvrir</button>
    </article>
  `).join('') || '<p>Aucune banque autorisee.</p>';
  $('#operatorChallenges').innerHTML = operatorChallenges.map((challenge) => `
    <article class="admin-item">
      <strong>${escapeHtml(challenge.title)}</strong>
      <p>${escapeHtml(challenge.category)} - ${escapeHtml(challenge.level)}</p>
      <button class="secondary" data-operator-target-type="challenge" data-operator-target-id="${escapeHtml(challenge.id)}">Ouvrir</button>
    </article>
  `).join('') || '<p>Aucun challenge autorise.</p>';
  updateOperatorTargets();
  $$('[data-operator-target-id]').forEach((button) => button.addEventListener('click', () => selectOperatorTarget(button.dataset.operatorTargetType, button.dataset.operatorTargetId)));
  if (!operatorTargetId) {
    const first = operatorBanks[0] ? ['bank', operatorBanks[0].id] : (operatorChallenges[0] ? ['challenge', operatorChallenges[0].id] : []);
    if (first.length) await selectOperatorTarget(first[0], first[1]);
  } else {
    await loadOperatorQuestions();
  }
}

function updateOperatorTargets() {
  const options = [
    ...operatorBanks.map((bank) => ({ type: 'bank', id: bank.id, label: `Banque - ${bank.title}` })),
    ...operatorChallenges.map((challenge) => ({ type: 'challenge', id: challenge.id, label: `Challenge - ${challenge.title}` }))
  ];
  ['#operatorManualTarget', '#operatorThemeTarget', '#operatorTextTarget'].forEach((selector) => {
    $(selector).innerHTML = options.map((item) => `<option value="${escapeHtml(item.type)}:${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('') || '<option value="">Aucun contenu</option>';
  });
}

async function selectOperatorTarget(type, id) {
  operatorTargetType = type;
  operatorTargetId = id;
  const value = `${type}:${id}`;
  ['#operatorManualTarget', '#operatorThemeTarget', '#operatorTextTarget'].forEach((selector) => { if ($(selector)) $(selector).value = value; });
  await loadOperatorQuestions();
}

function parseOperatorTarget(value) {
  const [type, ...idParts] = String(value || '').split(':');
  return { type, id: idParts.join(':') };
}

async function loadOperatorQuestions() {
  if (!operatorTargetId) return;
  const base = operatorTargetType === 'challenge' ? 'challenges' : 'question-banks';
  const data = await api(`/api/operator/${base}/${encodeURIComponent(operatorTargetId)}/questions`);
  $('#operatorQuestions').innerHTML = (data.questions || []).map((question) => `
    <article class="admin-item">
      <strong>${escapeHtml(question.question)}</strong>
      <p>${escapeHtml(question.type)} - ${escapeHtml(question.difficulty || question.level)} - ${escapeHtml(question.status || (question.isActive ? 'active' : 'inactive'))}</p>
      <p>${escapeHtml(question.reference || '')}</p>
      <div class="admin-item-actions">
        <button class="secondary" data-operator-edit="${escapeHtml(question.id)}">Modifier</button>
        <button class="secondary" data-operator-publish="${escapeHtml(question.id)}">Publier</button>
        <button class="secondary" data-operator-disable="${escapeHtml(question.id)}">Desactiver</button>
        <button class="secondary" data-operator-delete="${escapeHtml(question.id)}">Supprimer</button>
      </div>
    </article>
  `).join('') || '<p>Aucune question.</p>';
  $$('[data-operator-publish]').forEach((button) => button.addEventListener('click', () => operatorPublishQuestion(button.dataset.operatorPublish)));
  $$('[data-operator-edit]').forEach((button) => button.addEventListener('click', () => operatorEditQuestion(button.dataset.operatorEdit, data.questions.find((question) => question.id === button.dataset.operatorEdit))));
  $$('[data-operator-disable]').forEach((button) => button.addEventListener('click', () => operatorPatchQuestion(button.dataset.operatorDisable, { status: 'inactive', isActive: false })));
  $$('[data-operator-delete]').forEach((button) => button.addEventListener('click', () => operatorDeleteQuestion(button.dataset.operatorDelete)));
}

async function operatorAddManualQuestion(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const target = parseOperatorTarget(form.get('targetId'));
  if (!target.id) return;
  operatorTargetType = target.type;
  operatorTargetId = target.id;
  const base = target.type === 'challenge' ? 'challenges' : 'question-banks';
  await api(`/api/operator/${base}/${encodeURIComponent(target.id)}/questions/manual`, {
    method: 'POST',
    body: operatorQuestionBody(form)
  });
  event.currentTarget?.reset?.();
  updateOperatorTargets();
  await loadOperatorQuestions();
}

async function operatorGenerateQuestions(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const target = parseOperatorTarget(form.get('targetId'));
  if (!target.id) return;
  operatorTargetType = target.type;
  operatorTargetId = target.id;
  const base = target.type === 'challenge' ? 'challenges' : 'question-banks';
  const method = event.currentTarget.id === 'operatorGenerateText' ? 'generate-from-text' : 'generate-from-theme';
  await api(`/api/operator/${base}/${encodeURIComponent(target.id)}/questions/${method}`, {
    method: 'POST',
    body: {
      theme: form.get('theme'),
      rawText: form.get('rawText'),
      count: Number(form.get('count') || 5),
      category: form.get('category'),
      difficulty: form.get('difficulty'),
      type: form.get('type'),
      questionTypes: [form.get('type')],
      instruction: form.get('instruction'),
      textOnly: form.get('textOnly') === 'on'
    }
  });
  await loadOperatorQuestions();
}

function operatorQuestionBody(form) {
  return {
    question: form.get('question'),
    type: form.get('type'),
    options: String(form.get('options') || '').split('|').map((item) => item.trim()).filter(Boolean),
    correctAnswer: form.get('correctAnswer'),
    explanation: form.get('explanation'),
    reference: form.get('reference'),
    difficulty: form.get('difficulty'),
    tags: String(form.get('tags') || '').split(',').map((item) => item.trim()).filter(Boolean),
    status: form.get('status'),
    isActive: form.get('status') === 'active'
  };
}

async function operatorPublishQuestion(id) {
  await api(`/api/operator/questions/${encodeURIComponent(id)}/publish`, { method: 'POST', body: {} });
  await loadOperatorQuestions();
}

async function operatorEditQuestion(id, question) {
  if (!question) return;
  const nextQuestion = prompt('Question', question.question);
  if (nextQuestion === null) return;
  const correctAnswer = prompt('Bonne reponse', question.correctAnswer || '');
  if (correctAnswer === null) return;
  const explanation = prompt('Explication', question.explanation || '');
  if (explanation === null) return;
  await operatorPatchQuestion(id, { ...question, question: nextQuestion, correctAnswer, explanation });
}

async function operatorPatchQuestion(id, patch) {
  await api(`/api/operator/questions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  await loadOperatorQuestions();
}

async function operatorDeleteQuestion(id) {
  if (!confirm('Supprimer cette question ?')) return;
  await api(`/api/operator/questions/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
  await loadOperatorQuestions();
}

async function loadAdmin() {
  const data = await api('/api/admin/dashboard');
  questionBanks = data.questionBanks || questionBanks;
  $('#adminLogin').classList.add('hidden');
  $('#adminPanel').classList.remove('hidden');
  setAccessMessage('admin', '');
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
        <button class="secondary" data-toggle-challenge="${escapeHtml(challenge.id)}">${challenge.isActive === false ? 'Publier' : 'Depublier'}</button>
        <button class="secondary" data-assign-challenge="${escapeHtml(challenge.id)}">Operateurs</button>
        <button class="secondary" data-delete-challenge="${escapeHtml(challenge.id)}">Supprimer</button>
      </div>
    </article>
  `).join('');
  $('#adminStats').innerHTML = `
    <p><strong>${data.sessions.length}</strong> parties jouees</p>
    <p><strong>${data.leaderboard.length}</strong> scores enregistres</p>
    <p><strong>${data.challenges.length}</strong> challenges</p>
  `;
  const leaderboardLevels = [
    ['debutant', 'Debutant'],
    ['intermediaire', 'Intermediaire'],
    ['avance', 'Avance'],
    ['expert', 'Expert'],
    ['scholar', 'Scholar']
  ];
  $('#adminLeaderboard').innerHTML = `
    <p><strong>${data.leaderboard.length}</strong> entree(s) dans le classement.</p>
    <div class="admin-item-actions">
      <button class="secondary danger" data-leaderboard-reset="">Reinitialiser le leaderboard</button>
      ${leaderboardLevels.map(([level, label]) => {
        const count = (data.leaderboard || []).filter((row) => row.level === level).length;
        return `<button class="secondary" data-leaderboard-reset="${escapeHtml(level)}">${escapeHtml(label)} (${count})</button>`;
      }).join('')}
    </div>
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
  $('#adminUsers').innerHTML = (data.users || []).map((user) => `
    <article class="admin-item">
      <strong>${escapeHtml(user.source === 'env' ? 'Admin systeme (.env)' : (user.name || user.email || user.username))}</strong>
      <p>${escapeHtml(user.email || user.username || '')} - ${escapeHtml(user.role)} - ${user.source === 'env' ? 'permanent' : (user.isActive === false ? 'desactive' : 'actif')}</p>
      <div class="admin-item-actions">
        <select data-user-role="${escapeHtml(user.id)}" ${user.source === 'env' ? 'disabled' : ''}>
          ${['admin', 'operator', 'host', 'player'].map((role) => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${role}</option>`).join('')}
        </select>
        <button class="secondary" data-user-status="${escapeHtml(user.id)}" ${user.source === 'env' ? 'disabled' : ''}>${user.isActive === false ? 'Activer' : 'Desactiver'}</button>
        <button class="secondary" data-user-password="${escapeHtml(user.id)}" ${user.source === 'env' ? 'disabled' : ''}>Mot de passe</button>
      </div>
    </article>
  `).join('') || '<p>Aucun utilisateur.</p>';
  $('#adminQuestionBanks').innerHTML = (data.questionBanks || []).map((bank) => {
    const count = (data.bankQuestions || []).filter((question) => question.bankId === bank.id).length;
    return `
      <article class="admin-item">
        <strong>${escapeHtml(bank.title)}</strong>
        <p>${escapeHtml(bank.category)} - ${escapeHtml(bank.difficulty)} - ${count} questions - ${bank.isPublic ? 'publique' : 'privee'}</p>
        <p>Operateurs: ${escapeHtml((bank.operatorIds || []).join(', ') || 'aucun')}</p>
        <div class="admin-item-actions">
          <button class="secondary" data-bank-toggle="${escapeHtml(bank.id)}">${bank.isActive === false ? 'Publier' : 'Depublier'}</button>
          <button class="secondary" data-bank-assign="${escapeHtml(bank.id)}">Operateurs</button>
          <button class="secondary" data-bank-delete="${escapeHtml(bank.id)}">Supprimer</button>
        </div>
      </article>
    `;
  }).join('') || '<p>Aucune banque.</p>';
  $('#bankQuestionBankSelect').innerHTML = (data.questionBanks || []).map((bank) => `<option value="${escapeHtml(bank.id)}">${escapeHtml(bank.title)}</option>`).join('') || '<option value="">Aucune banque</option>';
  $$('[data-edit]').forEach((button) => button.addEventListener('click', () => editQuestion(data.questions.find((q) => q.id === button.dataset.edit))));
  $$('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteQuestion(button.dataset.delete)));
  $$('[data-toggle]').forEach((button) => button.addEventListener('click', () => toggleQuestion(data.questions.find((q) => q.id === button.dataset.toggle))));
  $$('[data-edit-challenge]').forEach((button) => button.addEventListener('click', () => editChallenge(data.challenges.find((c) => c.id === button.dataset.editChallenge))));
  $$('[data-toggle-challenge]').forEach((button) => button.addEventListener('click', () => toggleChallenge(data.challenges.find((c) => c.id === button.dataset.toggleChallenge))));
  $$('[data-assign-challenge]').forEach((button) => button.addEventListener('click', () => adminAssignChallenge(data.challenges.find((c) => c.id === button.dataset.assignChallenge))));
  $$('[data-delete-challenge]').forEach((button) => button.addEventListener('click', () => deleteChallenge(button.dataset.deleteChallenge)));
  $$('[data-admin-room-close]').forEach((button) => button.addEventListener('click', () => adminCloseRoom(button.dataset.adminRoomClose)));
  $$('[data-admin-room-delete]').forEach((button) => button.addEventListener('click', () => adminDeleteRoom(button.dataset.adminRoomDelete)));
  $$('[data-admin-room-regen]').forEach((button) => button.addEventListener('click', () => adminRegenerateRoom(button.dataset.adminRoomRegen)));
  $$('[data-user-role]').forEach((select) => select.addEventListener('change', () => adminUpdateUserRole(select.dataset.userRole, select.value)));
  $$('[data-user-status]').forEach((button) => button.addEventListener('click', () => adminToggleUserStatus(button.dataset.userStatus, data.users.find((user) => user.id === button.dataset.userStatus))));
  $$('[data-user-password]').forEach((button) => button.addEventListener('click', () => adminResetUserPassword(button.dataset.userPassword)));
  $$('[data-bank-toggle]').forEach((button) => button.addEventListener('click', () => adminToggleBank(data.questionBanks.find((bank) => bank.id === button.dataset.bankToggle))));
  $$('[data-bank-assign]').forEach((button) => button.addEventListener('click', () => adminAssignBank(data.questionBanks.find((bank) => bank.id === button.dataset.bankAssign))));
  $$('[data-bank-delete]').forEach((button) => button.addEventListener('click', () => adminDeleteBank(button.dataset.bankDelete)));
  $$('[data-leaderboard-reset]').forEach((button) => button.addEventListener('click', () => adminResetLeaderboard(button.dataset.leaderboardReset)));
}

async function handleProtectedView(view) {
  if (view === 'admin') {
    try {
      await loadAdmin();
      await syncNavigationRole();
      return;
    } catch (error) {
      const { user } = await currentAuthUser();
      if (!user) {
        redirectToLogin('Connexion requise pour acceder a l administration.', 'admin');
        return;
      }
      showAccessDenied('admin', new Error(user.role === 'admin' ? error.message : 'Acces non autorise'));
      return;
    }
  }

  const { user } = await currentAuthUser();
  if (!user) {
    redirectToLogin('Connexion requise pour acceder a l espace operateur.', 'operator');
    return;
  }
  if (!['admin', 'operator'].includes(user.role)) {
    showAccessDenied('operator', new Error('Acces non autorise'));
    return;
  }
  try {
    await loadOperator();
    await syncNavigationRole();
  } catch (error) {
    showAccessDenied('operator', error);
  }
}

async function currentAuthUser() {
  try {
    return await api('/api/auth/me');
  } catch {
    return { user: null };
  }
}

function redirectToLogin(message, targetView = '') {
  pendingProtectedView = targetView;
  showView('login');
  if (targetView) history.replaceState(null, '', `/login?redirect=/${targetView}`);
  $('#loginMessage').textContent = message || '';
}

function showAccessDenied(scope, error) {
  const isAdminScope = scope === 'admin';
  $(`#${scope}Panel`)?.classList.add('hidden');
  $(`#${scope}Login`)?.classList.remove('hidden');
  setAccessMessage(scope, error?.message || (isAdminScope ? 'Acces non autorise. Connexion administrateur requise.' : 'Acces non autorise. Connexion operateur requise.'));
}

function setAccessMessage(scope, message) {
  const target = $(`#${scope}AccessMessage`);
  if (target) target.textContent = message || '';
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1).replace(/\.0$/, '')}%`;
}

function formatDurationSeconds(value) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0)));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
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

async function addQuestionBank(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api('/api/admin/question-banks', {
    method: 'POST',
    body: {
      title: form.get('title'),
      description: form.get('description'),
      category: form.get('category'),
      difficulty: form.get('difficulty'),
      operatorIds: form.get('operatorIds'),
      isPublic: form.get('isPublic') === 'on'
    }
  });
  event.currentTarget?.reset?.();
  await Promise.all([loadAdmin(), loadQuestionBanks()]);
}

async function adminCreateUser(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api('/api/admin/users', {
    method: 'POST',
    body: {
      name: form.get('name'),
      email: form.get('email'),
      password: form.get('password'),
      role: form.get('role'),
      isActive: form.get('isActive') === 'on'
    }
  });
  event.currentTarget?.reset?.();
  await loadAdmin();
}

async function addBankQuestion(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const bankId = form.get('bankId');
  if (!bankId) return;
  const bank = questionBanks.find((item) => item.id === bankId);
  await api(`/api/question-banks/${encodeURIComponent(bankId)}/questions`, {
    method: 'POST',
    body: {
      question: form.get('question'),
      options: String(form.get('options')).split('|').map((item) => item.trim()),
      correctAnswer: form.get('correctAnswer'),
      explanation: form.get('explanation'),
      reference: form.get('reference'),
      category: bank?.category || 'random',
      difficulty: bank?.difficulty || 'intermediaire'
    }
  });
  event.currentTarget?.reset?.();
  await loadAdmin();
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

async function toggleChallenge(challenge) {
  if (!challenge) return;
  await api(`/api/admin/challenges/${encodeURIComponent(challenge.id)}`, {
    method: 'PUT',
    body: { ...challenge, isActive: challenge.isActive === false }
  });
  await Promise.all([loadAdmin(), loadChallenges()]);
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
  form.elements.operatorIds.value = (challenge.operatorIds || []).join(', ');
  form.elements.days.value = challenge.days || 7;
  form.elements.isActive.checked = challenge.isActive !== false;
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

async function adminResetLeaderboard(level = '') {
  if (!confirm('Cette action supprimera tous les scores du classement. Continuer ?')) return;
  const query = level ? `?level=${encodeURIComponent(level)}` : '';
  const result = await api(`/api/admin/leaderboard/reset${query}`, { method: 'DELETE', body: {} });
  await Promise.all([loadAdmin(), loadLeaderboard()]);
  const scope = level ? ` pour le niveau ${level}` : '';
  setAccessMessage('admin', `${result.deletedCount || 0} score(s) supprime(s)${scope}. Le classement est reinitialise.`);
}

async function adminUpdateUserRole(id, role) {
  await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { role } });
  await loadAdmin();
}

async function adminToggleUserStatus(id, user) {
  await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { isActive: user?.isActive === false } });
  await loadAdmin();
}

async function adminResetUserPassword(id) {
  const password = prompt('Nouveau mot de passe temporaire');
  if (!password) return;
  await api(`/api/admin/users/${encodeURIComponent(id)}/password`, { method: 'PATCH', body: { password } });
  await loadAdmin();
}

async function adminToggleBank(bank) {
  if (!bank) return;
  await api(`/api/admin/question-banks/${encodeURIComponent(bank.id)}`, { method: 'PATCH', body: { ...bank, isActive: bank.isActive === false } });
  await Promise.all([loadAdmin(), loadQuestionBanks()]);
}

async function adminAssignBank(bank) {
  if (!bank) return;
  const operatorIds = prompt('IDs operateurs separes par virgule', (bank.operatorIds || []).join(', '));
  if (operatorIds === null) return;
  await api(`/api/admin/question-banks/${encodeURIComponent(bank.id)}`, { method: 'PATCH', body: { ...bank, operatorIds } });
  await loadAdmin();
}

async function adminDeleteBank(id) {
  if (!confirm('Supprimer cette banque ?')) return;
  await api(`/api/admin/question-banks/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
  await loadAdmin();
}

async function adminAssignChallenge(challenge) {
  if (!challenge) return;
  const operatorIds = prompt('IDs operateurs separes par virgule', (challenge.operatorIds || []).join(', '));
  if (operatorIds === null) return;
  await api(`/api/admin/challenges/${encodeURIComponent(challenge.id)}`, { method: 'PUT', body: { ...challenge, operatorIds } });
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
  document.body.classList.toggle('champion-immersive', data.room?.gameMode === 'champion' && ['preparing_questions', 'starting_countdown', 'starting', 'question_active', 'question_reveal', 'between_questions', 'finished'].includes(data.phase));
  setCompetitionImmersive(['preparing_questions', 'starting_countdown', 'starting', 'question_active', 'question_reveal', 'between_questions', 'finished'].includes(data.phase));
  syncCompetitionCountdown(data);
  const room = data.room;
  $('#roomPanel').classList.remove('hidden');
  const roundLabel = data.round?.championRoundLabel ? ` - ${data.round.championRoundLabel}` : '';
  $('#roomStatus').textContent = `${labelPhase(data.phase || room.status)}${roundLabel} - ${room.difficulty}`;
  $('#roomTitle').textContent = room.name;
  $('#roomDescription').textContent = room.description || 'En attente des amis. Partagez le code puis lancez la partie.';
  $('#roomParticipants').textContent = data.participants?.length || room.participantCount || room.participants?.length || 0;
  $('#roomRounds').textContent = room.roundCount || room.rounds?.length || 0;
  $('#roomCode').textContent = room.accessCode;
  $('#roomRoundsHistory').innerHTML = (room.rounds || []).map((round) => `
    <article class="admin-item">
      <strong>${room.gameMode === 'champion' ? `Manche ${round.roundNumber}${round.championRoundLabel ? ` - ${escapeHtml(round.championRoundLabel)}` : ''}` : `Partie ${round.roundNumber}`} - ${escapeHtml(round.phase || round.status)}</strong>
      <p>${new Date(round.startsAt).toLocaleString('fr-FR')} - ${new Date(round.endsAt).toLocaleString('fr-FR')}</p>
      <p>IA: ${round.generatedByAI ? 'oui' : 'fallback local'} - validation: ${escapeHtml(round.validationStatus)}</p>
    </article>
  `).join('') || '<p>Aucun tour.</p>';
  renderRoomLeaderboard(data.leaderboard || []);
  $('#startRound').disabled = ['preparing_questions', 'starting_countdown', 'question_active', 'question_reveal', 'between_questions'].includes(data.phase);
  renderPhase(data);
}

function renderPhase(data) {
  const phase = data.phase || 'waiting';
  const question = data.currentQuestion;
  $('#competitionScore').textContent = `${data.score || 0} pts`;
  $('#competitionCounter').textContent = data.totalQuestions ? `Question ${data.questionIndex + 1}/${data.totalQuestions}` : 'En attente';
  $('#competitionTimer').textContent = `${data.countdownSeconds || 0}s`;
  const activeTimeLimit = data.questionTimeLimit || data.room?.questionTimeLimit || 0;
  $('#competitionTimerBar').style.width = activeTimeLimit
    ? `${Math.max(0, Math.min(100, (data.timeRemainingMs / (activeTimeLimit * 1000)) * 100))}%`
    : '0%';

  if (phase === 'waiting') {
    $('#competitionBoard').classList.add('hidden');
    $('#competitionResults').classList.remove('hidden');
    const startAt = data.room?.scheduledStartAt ? new Date(data.room.scheduledStartAt) : null;
    const startsLater = startAt && startAt > new Date();
    $('#competitionResults').innerHTML = startsLater
      ? `<p class="eyebrow">Competition planifiee</p><h2>La competition commence dans ${formatCountdown(startAt - new Date())}</h2><p>Les joueurs peuvent rejoindre le salon avant le lancement.</p>`
      : '<p class="eyebrow">Salle d attente</p><h2>Partagez le code</h2><p>La partie commencera quand le createur cliquera sur Lancer la partie.</p>';
    return;
  }
  if (phase === 'preparing_questions') {
    $('#competitionBoard').classList.add('hidden');
    $('#competitionResults').classList.remove('hidden');
    $('#competitionResults').innerHTML = `
      <div class="loading-state">
        <span class="spinner" aria-hidden="true"></span>
        <p class="eyebrow">${data.room?.gameMode === 'champion' ? 'Preparation des questions...' : 'Preparation des questions'}</p>
        <h2>${data.room?.gameMode === 'champion' ? 'Plateau en preparation.' : 'Nous preparons les questions bibliques pour votre partie.'}</h2>
        <p>L'IA peut prendre quelques secondes selon le niveau choisi.</p>
        <p>Le chrono de jeu demarrera seulement apres le compte a rebours.</p>
      </div>
    `;
    return;
  }
  if (phase === 'starting_countdown' || phase === 'starting') {
    $('#competitionBoard').classList.add('hidden');
    $('#competitionResults').classList.remove('hidden');
    $('#competitionResults').innerHTML = `
      ${data.preparationMessage && data.preparationMessage !== 'Questions pretes.' ? `<p class="form-message ok">${escapeHtml(data.preparationMessage)}</p>` : ''}
      <p class="eyebrow">${data.round?.championRoundLabel || 'Lancement'}</p>
      <h2>${data.room?.gameMode === 'champion' ? 'Attention, premiere question dans...' : 'La partie commence dans...'}</h2>
      <strong class="countdown-number">${data.countdownSeconds || 1}</strong>
    `;
    return;
  }
  if (phase === 'finished') {
    $('#competitionBoard').classList.add('hidden');
    $('#competitionResults').classList.remove('hidden');
    renderCompetitionResults(data.results);
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
    $('#competitionFeedbackTitle').textContent = data.currentAnswer ? 'Reponse selectionnee' : championPromptTitle(data);
    $('#competitionFeedbackText').textContent = data.currentAnswer ? 'Reponse selectionnee - tu peux changer avant la fin du chrono.' : championPromptText(data);
    $('#competitionReference').textContent = '';
    return;
  }
  if (phase === 'question_reveal' || phase === 'between_questions') {
    const currentPoints = Number(data.currentAnswer?.totalPoints || 0);
    const leaderboard = renderInlineLeaderboard(data.leaderboard || []);
    $('#competitionFeedbackTitle').textContent = `Bonne reponse : ${question.correctAnswer}`;
    $('#competitionFeedbackText').innerHTML = `
      <span>${escapeHtml(question.explanation || 'Explication indisponible.')}</span>
      ${question.historicalNote ? `<span>Note historique : ${escapeHtml(question.historicalNote)}</span>` : ''}
      <strong>Points gagnes : ${currentPoints}</strong>
      ${data.currentAnswer?.streakBonus ? `<span>Bonus serie : ${Number(data.currentAnswer.streakBonus)} pts</span>` : ''}
      <span>Prochaine question dans ${data.countdownSeconds || 0}...</span>
      ${leaderboard}
    `;
    $('#competitionReference').textContent = question.reference ? `Reference : ${question.reference}` : '';
  }
}

function renderChampionClues(data, question) {
  const existing = $('.champion-clues');
  if (existing) existing.remove();
  if (data.room?.gameMode !== 'champion' || data.round?.championRoundType !== 'who_am_i' || !question.clues?.length) return;
  const elapsedRatio = data.questionTimeLimit ? 1 - (data.timeRemainingMs / (data.questionTimeLimit * 1000)) : 0;
  const visibleCount = Math.max(1, Math.min(question.clues.length, Math.ceil(elapsedRatio * question.clues.length) || 1));
  const clues = document.createElement('div');
  clues.className = 'champion-clues';
  clues.innerHTML = question.clues.slice(0, visibleCount).map((clue, index) => `<span><b>Indice ${index + 1}</b>${escapeHtml(clue)}</span>`).join('');
  $('#competitionQuestion')?.insertAdjacentElement('afterend', clues);
}

function championPromptTitle(data) {
  if (data.room?.gameMode !== 'champion') return 'A vous de jouer';
  return {
    top_chrono: 'Top Chrono',
    four_in_a_row: 'Gardez la serie',
    who_am_i: 'Repondez avant le dernier indice',
    face_off: 'Buzzer humain'
  }[data.round?.championRoundType] || 'A vous de jouer';
}

function championPromptText(data) {
  if (data.room?.gameMode !== 'champion') return 'Repondez avant la fin du chrono.';
  return {
    top_chrono: 'Reponse rapide: vitesse et serie augmentent le score.',
    four_in_a_row: 'Objectif: 4 bonnes reponses de suite. Une erreur casse la serie.',
    who_am_i: 'Plus la reponse arrive tot, plus elle rapporte.',
    face_off: 'Deux joueurs humains uniquement: le plus rapide repond, l autre peut voler apres erreur.'
  }[data.round?.championRoundType] || 'Repondez avant la fin du chrono.';
}

function maybeSpeakChampionQuestion(data, question) {
  if (data.room?.gameMode !== 'champion' || !data.room?.championVoiceEnabled || !window.speechSynthesis) return;
  const key = `${data.round?.id}:${question.id}`;
  if (competition.spokenQuestionKey === key) return;
  competition.spokenQuestionKey = key;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(question.question);
  utterance.lang = 'fr-FR';
  utterance.rate = 1.03;
  window.speechSynthesis.speak(utterance);
}

function renderCompetitionResults(results) {
  const players = results?.players || [];
  const winner = results?.winner;
  $('#competitionResults').innerHTML = `
    <p class="eyebrow">Classement final</p>
    <h2>${winner ? `${escapeHtml(winner.playerName)} remporte la partie` : 'Partie terminee'}</h2>
    <div class="result-actions">
      <button class="primary" id="replayCompetition" type="button">${competition.room?.gameMode === 'champion' ? 'Manche suivante' : 'Rejouer'}</button>
      <button class="secondary" id="backHomeFromCompetition" type="button">Retour accueil</button>
    </div>
    <div class="final-results">
      ${players.length ? players.map((player) => `
        <article class="final-result-row">
          <strong>${player.rank}. ${escapeHtml(player.playerName)}</strong>
          <span>${Number(player.totalScore || 0)} pts</span>
          <span>${Number(player.correctAnswers || 0)}/${Number(player.totalAnswers || 0)} bonnes reponses</span>
          <span>${formatMs(player.averageResponseTimeMs)}</span>
        </article>
      `).join('') : '<p>Aucun resultat disponible.</p>'}
    </div>
  `;
  $('#replayCompetition')?.addEventListener('click', () => startCompetitionRound({ currentTarget: $('#replayCompetition') }));
  $('#backHomeFromCompetition')?.addEventListener('click', () => {
    stopCompetitionPolling();
    setCompetitionImmersive(false);
    showView('home');
  });
}

function formatMs(ms) {
  const seconds = Math.round(Number(ms || 0) / 100) / 10;
  return `${seconds}s moy.`;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
  }
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

async function startCompetitionRound(event) {
  if (!competition.room) return;
  const button = event?.currentTarget || $('#startRound');
  setButtonLoading(button, true);
  button.disabled = true;
  setRoomActionMessage('Preparation des questions...', true);
  renderPhase({
    room: competition.room,
    phase: 'preparing_questions',
    participants: competition.lastState?.participants || competition.room.participants || [],
    leaderboard: competition.lastState?.leaderboard || [],
    score: competition.lastState?.score || 0,
    totalQuestions: 0,
    questionIndex: 0
  });
  try {
    const creatorId = localStorage.getItem('quizBibleCreatorId') || '';
    const participantId = competition.participant?.id || getStoredParticipant(competition.room.id);
    const data = await api(`/api/rooms/${encodeURIComponent(competition.room.id)}/start-round?code=${encodeURIComponent(competition.room.accessCode)}`, {
      method: 'POST',
      body: { creatorId, participantId }
    });
    renderCompetitionState(data);
    startCompetitionPolling();
    setRoomActionMessage('Preparation lancee.', true);
  } catch (error) {
    console.error('startCompetitionRound failed', error);
    setRoomActionMessage(error.message || 'Lancement impossible.');
  } finally {
    setButtonLoading(button, false);
    button.disabled = ['preparing_questions', 'starting_countdown', 'question_active', 'question_reveal', 'between_questions'].includes(competition.lastState?.phase);
  }
}

async function submitCompetitionAnswer(button, selectedAnswer) {
  if (!competition.round || !competition.lastState?.currentQuestion) return;
  $$('#competitionAnswers .answer').forEach((answerButton) => answerButton.classList.toggle('selected', answerButton === button));
  $('#competitionFeedback').classList.remove('hidden');
  $('#competitionFeedbackTitle').textContent = 'Reponse selectionnee';
  $('#competitionFeedbackText').textContent = 'Reponse selectionnee - tu peux changer avant la fin du chrono.';
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
  const wasActive = document.body.classList.contains('competition-immersive');
  if (active && !$('#competitionView')?.classList.contains('active')) showView('competition');
  document.body.classList.toggle('competition-immersive', active);
  if (!active) document.body.classList.remove('champion-immersive');
  if (active && !wasActive) window.scrollTo({ top: 0, left: 0 });
}

function setGameImmersive(active) {
  const wasActive = document.body.classList.contains('game-immersive');
  document.body.classList.toggle('game-immersive', active);
  if (active && !$('#playView')?.classList.contains('active')) showView('play');
  if (active && !wasActive) window.scrollTo({ top: 0, left: 0 });
}

function syncCompetitionCountdown(data) {
  clearTimeout(competition.phaseTimeoutId);
  clearInterval(competition.countdownId);
  competition.phaseTimeoutId = null;
  competition.countdownId = null;

  const phaseEndsAt = data.phaseEndsAt ? new Date(data.phaseEndsAt).getTime() : 0;
  const serverNow = data.serverNow ? new Date(data.serverNow).getTime() : Date.now();
  if (!phaseEndsAt) {
    if (data.phase === 'preparing_questions') {
      $('#competitionTimer').textContent = '';
      $('#competitionTimerBar').style.width = '0%';
    }
    return;
  }

  const serverOffset = serverNow - Date.now();
  const phaseKey = `${data.round?.id || 'room'}:${data.phase}:${data.questionIndex}:${phaseEndsAt}`;
  const updateCountdown = () => {
    const remainingMs = phaseEndsAt - (Date.now() + serverOffset);
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    $('#competitionTimer').textContent = `${seconds}s`;
    const activeTimeLimit = data.questionTimeLimit || data.room?.questionTimeLimit || 0;
    if (activeTimeLimit && data.phase === 'question_active') {
      $('#competitionTimerBar').style.width = `${Math.max(0, Math.min(100, (remainingMs / (activeTimeLimit * 1000)) * 100))}%`;
    }
    if (remainingMs <= 0 && competition.phaseRefreshKey !== phaseKey) {
      competition.phaseRefreshKey = phaseKey;
      clearTimeout(competition.phaseTimeoutId);
      clearInterval(competition.countdownId);
      loadCompetitionState().catch((error) => console.error('phase refresh failed', error));
    }
  };

  updateCountdown();
  competition.countdownId = setInterval(updateCountdown, 250);
  competition.phaseTimeoutId = setTimeout(updateCountdown, Math.max(0, phaseEndsAt - serverNow) + 20);
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
  if (competition.phaseTimeoutId) clearTimeout(competition.phaseTimeoutId);
  if (competition.countdownId) clearInterval(competition.countdownId);
  competition.pollId = null;
  competition.phaseTimeoutId = null;
  competition.countdownId = null;
  competition.phaseRefreshKey = null;
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
  updateQuestionBankVisibility();
  updateScheduleVisibility();
}

function labelPhase(phase) {
  return {
    waiting: 'Salle d attente',
    starting: 'Lancement',
    question_active: 'Question en cours',
    preparing_questions: 'Preparation des questions',
    starting_countdown: 'Compte a rebours',
    question_reveal: 'Correction',
    between_questions: 'Prochaine question',
    finished: 'Termine',
    closed: 'Ferme'
  }[phase] || phase;
}

if (localStorage.getItem('quizBibleTheme') === 'dark') {
  document.body.classList.add('dark');
}
