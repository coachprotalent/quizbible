const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv();

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 8;

const sessions = new Map();
const userSessions = new Map();
const generationHits = new Map();

const categories = [
  ['random', 'Quiz au hasard'],
  ['nouveau_testament', 'Nouveau Testament'],
  ['ancien_testament', 'Ancien Testament'],
  ['pentateuque', 'Pentateuque'],
  ['livres_historiques', 'Livres historiques'],
  ['livres_poetiques', 'Livres poetiques'],
  ['livres_prophetiques', 'Livres prophetiques'],
  ['evangiles', 'Evangiles'],
  ['actes', 'Actes des Apotres'],
  ['epitres', 'Epitres'],
  ['apocalypse', 'Apocalypse'],
  ['vie_des_prophetes', 'Vie des prophetes'],
  ['personnages', 'Personnages bibliques'],
  ['actions_personnages', 'Oeuvres / actions des personnages'],
  ['nom_personnage', 'Nom et personnage'],
  ['identification_avancee', 'Identification avancee'],
  ['contexte_historique', 'Bible d etude / contexte historique']
].map(([id, label]) => ({ id, label }));

const levels = [
  ['debutant', 'Debutant'],
  ['intermediaire', 'Intermediaire'],
  ['avance', 'Avance'],
  ['expert', 'Expert'],
  ['scholar', 'Scholar']
].map(([id, label]) => ({ id, label }));

const aiAntiRepetitionInstruction = 'Ne reutilise pas des questions classiques ou deja generees recemment. Evite les formulations generiques repetitives. Genere des questions variees, originales, pedagogiques et non redondantes.';
const scholarInstruction = 'Tu generes des questions bibliques avancees de niveau Scholar. Utilise le contexte historique, culturel, geopolitique et linguistique des evenements bibliques. Fais intervenir les empires antiques, les pratiques juives, la chronologie des prophetes, le contexte greco-romain et les elements couramment presents dans les Bibles d etude. Distingue clairement les faits bibliques directs du contexte historique associe. Evite les debats doctrinaux.';
const scholarTopics = [
  'contexte historique',
  'chronologie avancee',
  'geopolitique biblique',
  'empires antiques',
  'culture juive antique',
  'grec biblique simple',
  'symboles prophetiques',
  'paralleles entre prophetes',
  'references intertestamentaires',
  'details de Bibles d etude',
  'liens historiques entre personnages',
  'pratiques du Proche-Orient antique',
  'typologie biblique',
  'interpretation contextuelle simple',
  'contexte des expressions bibliques'
];
const rotationTopics = [
  'propheties',
  'chronologie',
  'contexte historique',
  'personnages',
  'symboles',
  'geographie',
  'culture antique',
  'pratiques juives',
  'empires et royaumes',
  'langage symbolique'
];

const questionTypes = [
  'qcm',
  'vrai_faux',
  'personnage',
  'livre_biblique',
  'completer_verset',
  'associer',
  'epoque_empire',
  'indice_progressif',
  'qui_suis_je',
  'contexte_historique',
  'comprehension_spirituelle'
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: 'Erreur serveur', detail: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Quiz Bible listening on http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/meta') {
    sendJson(res, 200, { categories, levels, questionTypes, appBaseUrl: process.env.APP_BASE_URL || '' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/questions') {
    const questions = readJson('questions.json').filter((q) => q.isActive !== false);
    sendJson(res, 200, { questions });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/challenges') {
    const challenges = readJson('challenges.json').filter((c) => c.isActive !== false);
    sendJson(res, 200, { challenges });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    sendJson(res, 200, { leaderboard: groupedLeaderboard() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start-game') {
    const body = await readBody(req);
    const count = clamp(Number(body.count || 10), 5, 20);
    const game = await createStartGame(body, count);
    sendJson(res, 200, { gameSessionId: game.gameSessionId, questions: game.questions.map(withoutAnswer) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/check-answer') {
    const body = await readBody(req);
    const checked = checkSingleAnswer(body);
    if (!checked) {
      sendJson(res, 404, { error: 'Question introuvable' });
      return;
    }
    sendJson(res, 200, checked);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/submit-game') {
    const body = await readBody(req);
    const result = scoreGame(body);
    const alreadyCounted = body.gameSessionId && readJson('leaderboard.json').some((row) => row.gameSessionId === body.gameSessionId);
    if (!alreadyCounted) {
      appendJson('sessions.json', result.session);
      appendJson('leaderboard.json', result.leaderboard);
    }
    result.duplicateSubmission = Boolean(alreadyCounted);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate-questions') {
    if (!rateLimit(req)) {
      sendJson(res, 429, { error: 'Trop de generations. Reessayez dans une minute.' });
      return;
    }
    const body = await readBody(req);
    const questions = await generateQuestions(body);
    sendJson(res, 200, { questions });
    return;
  }

  if (url.pathname === '/api/rooms' && req.method === 'GET') {
    const rooms = readJson('rooms.json')
      .map(refreshRoomStatus)
      .filter((room) => room.isPublic && ['waiting', 'active'].includes(room.status) && new Date(room.endDate) > new Date());
    sendJson(res, 200, { rooms: rooms.map(withRoomCounts) });
    return;
  }

  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    const room = sanitizeRoom(await readBody(req));
    const rooms = readJson('rooms.json');
    room.id = `room-${crypto.randomUUID()}`;
    room.creatorId = room.creatorId || `creator-${crypto.randomUUID()}`;
    room.accessCode = room.accessCode || createAccessCode(rooms);
    room.status = room.isScheduled && new Date(room.scheduledStartAt) > new Date() ? 'waiting' : 'active';
    room.createdAt = new Date().toISOString();
    rooms.push(room);
    writeJson('rooms.json', rooms);
    sendJson(res, 201, { room: withRoomCounts(room) });
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomMatch && req.method === 'GET') {
    const room = findRoom(decodeURIComponent(roomMatch[1]), url.searchParams.get('code'));
    if (!room) return sendJson(res, 404, { error: 'Salon introuvable' });
    sendJson(res, 200, { room: withRoomDetails(room) });
    return;
  }

  const roomStateMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/state$/);
  if (roomStateMatch && req.method === 'GET') {
    const room = findRoom(decodeURIComponent(roomStateMatch[1]), url.searchParams.get('code'));
    if (!room) return sendJson(res, 404, { error: 'Salon introuvable ou code invalide' });
    await ensureAutoStart(room);
    sendJson(res, 200, buildRoomState(room, url.searchParams.get('participantId')));
    return;
  }

  const roomActionMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|leave|start-round|start|current-round|leaderboard|results|close)$/);
  if (roomActionMatch) {
    await handleRoomAction(req, res, roomActionMatch, url);
    return;
  }

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    const result = registerUser(await readBody(req));
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    sendUserSession(res, result.user);
    sendJson(res, 201, { user: publicUser(result.user) });
    return;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const result = loginUser(await readBody(req));
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    sendUserSession(res, result.user);
    sendJson(res, 200, { user: publicUser(result.user) });
    return;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = getCookie(req, 'qb_user_session');
    if (token) userSessions.delete(token);
    const adminToken = getCookie(req, 'qb_session');
    if (adminToken) sessions.delete(adminToken);
    res.setHeader('Set-Cookie', [
      'qb_user_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      'qb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
    ]);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    sendJson(res, 200, { user: publicUser(currentUser(req)) });
    return;
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    const user = requireRole(req, ['admin']);
    if (!user) return sendJson(res, 403, { error: 'Role admin requis' });
    sendJson(res, 200, { users: readJson('users.json').map(publicUser) });
    return;
  }

  const userRoleMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/(role|status)$/);
  if (userRoleMatch && req.method === 'PATCH') {
    const user = requireRole(req, ['admin']);
    if (!user) return sendJson(res, 403, { error: 'Role admin requis' });
    const result = updateUserAdmin(decodeURIComponent(userRoleMatch[1]), userRoleMatch[2], await readBody(req));
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    sendJson(res, 200, { user: publicUser(result.user) });
    return;
  }

  const bankRootMatch = url.pathname.match(/^\/api\/question-banks(?:\/([^/]+))?$/);
  if (bankRootMatch) {
    await handleQuestionBankApi(req, res, bankRootMatch, url);
    return;
  }

  const bankQuestionMatch = url.pathname.match(/^\/api\/question-banks\/([^/]+)\/questions$/);
  if (bankQuestionMatch) {
    await handleBankQuestionsApi(req, res, decodeURIComponent(bankQuestionMatch[1]));
    return;
  }

  const questionItemMatch = url.pathname.match(/^\/api\/questions\/([^/]+)$/);
  if (questionItemMatch && ['PATCH', 'DELETE'].includes(req.method)) {
    await handleBankQuestionItemApi(req, res, decodeURIComponent(questionItemMatch[1]));
    return;
  }

  if (url.pathname.startsWith('/api/operator/')) {
    const user = requireRole(req, ['admin', 'operator']);
    if (!user) return sendJson(res, 403, { error: 'Role operator requis' });
    await handleOperatorApi(req, res, url, user);
    return;
  }

  const roundAnswerMatch = url.pathname.match(/^\/api\/rounds\/([^/]+)\/answer$/);
  if (roundAnswerMatch && req.method === 'POST') {
    const result = submitRoundAnswer(decodeURIComponent(roundAnswerMatch[1]), await readBody(req));
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/ai/generate-round-questions' && req.method === 'POST') {
    if (!rateLimit(req)) return sendJson(res, 429, { error: 'Trop de generations. Reessayez dans une minute.' });
    const result = await generateRoundQuestions(await readBody(req));
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/ai/validate-questions' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await validateQuestionsWithAI(body.questions || [], body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const body = await readBody(req);
    if (envAdminCredentialsMatch(body.username, body.password)) {
      sendUserSession(res, envAdminUser());
      sendJson(res, 200, { ok: true, user: envAdminUser() });
      return;
    }
    sendJson(res, 401, { error: 'Identifiants invalides' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = getCookie(req, 'qb_session');
    if (token) sessions.delete(token);
    const userToken = getCookie(req, 'qb_user_session');
    if (userToken) userSessions.delete(userToken);
    res.setHeader('Set-Cookie', [
      'qb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      'qb_user_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
    ]);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/admin/')) {
    const user = requireRole(req, ['admin']);
    if (!user) {
      sendJson(res, 401, { error: 'Connexion admin requise' });
      return;
    }
    await handleAdminApi(req, res, url, user);
    return;
  }

  sendJson(res, 404, { error: 'Route introuvable' });
}

async function handleAdminApi(req, res, url, adminUser) {
  if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
    sendJson(res, 200, {
      questions: [],
      challenges: readJson('challenges.json'),
      sessions: readJson('sessions.json'),
      leaderboard: readJson('leaderboard.json'),
      rooms: readJson('rooms.json').map(withRoomCounts),
      roomParticipants: readJson('roomParticipants.json'),
      rounds: readJson('rounds.json'),
      roundQuestions: readJson('roundQuestions.json'),
      answers: readJson('answers.json'),
      users: [envAdminUser(), ...readJson('users.json').map(publicUser)],
      questionBanks: readJson('questionBanks.json'),
      bankQuestions: readJson('bankQuestions.json'),
      challengeQuestions: readJson('challengeQuestions.json'),
      aiErrors: readJson('aiErrors.json'),
      categories,
      levels
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/admin/leaderboard/reset') {
    const level = sanitizeString(url.searchParams.get('level') || '');
    const allowedLevels = new Set(levels.map((item) => item.id));
    const leaderboard = readJson('leaderboard.json');

    if (level && !allowedLevels.has(level)) {
      sendJson(res, 400, { error: 'Niveau de classement invalide' });
      return;
    }

    const targetLevelKey = level ? leaderboardLevelKey(level) : '';
    const nextLeaderboard = level
      ? leaderboard.filter((row) => leaderboardLevelKey(row.level) !== targetLevelKey)
      : [];

    writeJson('leaderboard.json', nextLeaderboard);
    sendJson(res, 200, {
      ok: true,
      deletedCount: leaderboard.length - nextLeaderboard.length,
      remainingCount: nextLeaderboard.length,
      level: level || null
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    sendJson(res, 200, { users: [envAdminUser(), ...readJson('users.json').map(publicUser)] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/users') {
    const result = createUserByAdmin(await readBody(req));
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    sendJson(res, 201, { user: publicUser(result.user) });
    return;
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(password|disable))?$/);
  if (adminUserMatch && req.method === 'PATCH') {
    if (decodeURIComponent(adminUserMatch[1]) === 'env-admin') {
      sendJson(res, 403, { error: 'Admin systeme non modifiable' });
      return;
    }
    const result = patchUserByAdmin(decodeURIComponent(adminUserMatch[1]), adminUserMatch[2] || 'profile', await readBody(req));
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    sendJson(res, 200, { user: publicUser(result.user) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/question-banks') {
    sendJson(res, 200, { questionBanks: readJson('questionBanks.json') });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/question-banks') {
    const bank = sanitizeQuestionBank(await readBody(req), adminUser);
    const banks = readJson('questionBanks.json');
    bank.id = `qb-${crypto.randomUUID()}`;
    bank.createdAt = new Date().toISOString();
    bank.updatedAt = bank.createdAt;
    banks.push(bank);
    writeJson('questionBanks.json', banks);
    sendJson(res, 201, { questionBank: bank });
    return;
  }

  const adminBankMatch = url.pathname.match(/^\/api\/admin\/question-banks\/([^/]+)$/);
  if (adminBankMatch && req.method === 'PATCH') {
    const banks = readJson('questionBanks.json');
    const bank = banks.find((item) => item.id === decodeURIComponent(adminBankMatch[1]));
    if (!bank) return sendJson(res, 404, { error: 'Banque introuvable' });
    Object.assign(bank, sanitizeQuestionBank({ ...bank, ...(await readBody(req)) }, { id: bank.createdBy }), { id: bank.id, createdBy: bank.createdBy, createdAt: bank.createdAt, updatedAt: new Date().toISOString() });
    writeJson('questionBanks.json', banks);
    sendJson(res, 200, { questionBank: bank });
    return;
  }

  if (adminBankMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(adminBankMatch[1]);
    writeJson('questionBanks.json', readJson('questionBanks.json').filter((item) => item.id !== id));
    writeJson('bankQuestions.json', readJson('bankQuestions.json').filter((question) => question.bankId !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/challenges') {
    const body = sanitizeChallenge(await readBody(req));
    const challenges = readJson('challenges.json');
    body.id = body.id || `ch-${crypto.randomUUID()}`;
    body.createdAt = body.createdAt || new Date().toISOString();
    challenges.push(body);
    writeJson('challenges.json', challenges);
    sendJson(res, 201, { challenge: body });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/challenges') {
    sendJson(res, 200, { challenges: readJson('challenges.json') });
    return;
  }

  const challengeMatch = url.pathname.match(/^\/api\/admin\/challenges\/([^/]+)$/);
  if (challengeMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
    const id = decodeURIComponent(challengeMatch[1]);
    const body = sanitizeChallenge(await readBody(req));
    const challenges = readJson('challenges.json');
    const index = challenges.findIndex((c) => c.id === id);
    if (index === -1) return sendJson(res, 404, { error: 'Challenge introuvable' });
    challenges[index] = { ...challenges[index], ...body, id };
    writeJson('challenges.json', challenges);
    sendJson(res, 200, { challenge: challenges[index] });
    return;
  }

  if (challengeMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(challengeMatch[1]);
    writeJson('challenges.json', readJson('challenges.json').filter((c) => c.id !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  const adminRoomMatch = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/(close|delete|regenerate)$/);
  if (adminRoomMatch) {
    const id = decodeURIComponent(adminRoomMatch[1]);
    const action = adminRoomMatch[2];
    if (action === 'close' && req.method === 'POST') {
      const room = updateRoomStatus(id, 'closed');
      if (!room) return sendJson(res, 404, { error: 'Salon introuvable' });
      sendJson(res, 200, { room });
      return;
    }
    if (action === 'delete' && req.method === 'DELETE') {
      deleteRoom(id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'regenerate' && req.method === 'POST') {
      const room = readJson('rooms.json').find((item) => item.id === id);
      if (!room) return sendJson(res, 404, { error: 'Salon introuvable' });
      const round = latestRoundForRoom(id) || createRound(room);
      const generated = await createQuestionsForRound(room, round);
      sendJson(res, 200, { round: readJson('rounds.json').find((item) => item.id === round.id) || round, questions: generated });
      return;
    }
  }

  sendJson(res, 404, { error: 'Route admin introuvable' });
}

async function handleOperatorApi(req, res, url, user) {
  if (req.method === 'GET' && url.pathname === '/api/operator/question-banks') {
    const banks = readJson('questionBanks.json').filter((bank) => canOperateStructure(user, bank));
    sendJson(res, 200, { questionBanks: banks });
    return;
  }

  const bankQuestionsMatch = url.pathname.match(/^\/api\/operator\/question-banks\/([^/]+)\/questions(?:\/(manual|generate-from-theme|generate-from-text))?$/);
  if (bankQuestionsMatch) {
    const bank = readJson('questionBanks.json').find((item) => item.id === decodeURIComponent(bankQuestionsMatch[1]));
    if (!bank || !canOperateStructure(user, bank)) return sendJson(res, 403, { error: 'Banque non autorisee' });
    const method = bankQuestionsMatch[2] || '';
    if (req.method === 'GET') {
      return sendJson(res, 200, { questions: readJson('bankQuestions.json').filter((question) => question.bankId === bank.id) });
    }
    if (req.method === 'POST' && method === 'manual') {
      const questions = readJson('bankQuestions.json');
      const question = sanitizeBankQuestion({ ...(await readBody(req)), status: 'active' }, bank.id);
      question.id = `bq-${crypto.randomUUID()}`;
      questions.push(question);
      writeJson('bankQuestions.json', questions);
      return sendJson(res, 201, { question });
    }
    if (req.method === 'POST' && ['generate-from-theme', 'generate-from-text'].includes(method)) {
      const generated = await generateOperatorDrafts(await readBody(req), method);
      const questions = readJson('bankQuestions.json');
      const saved = generated.map((item) => ({ ...sanitizeBankQuestion({ ...item, status: 'draft' }, bank.id), id: `bq-${crypto.randomUUID()}` }));
      writeJson('bankQuestions.json', questions.concat(saved));
      return sendJson(res, 201, { questions: saved });
    }
  }

  const operatorQuestionMatch = url.pathname.match(/^\/api\/operator\/questions\/([^/]+)(?:\/publish)?$/);
  if (operatorQuestionMatch) {
    const questionId = decodeURIComponent(operatorQuestionMatch[1]);
    const bankQuestions = readJson('bankQuestions.json');
    const challengeQuestions = readJson('challengeQuestions.json');
    let questions = bankQuestions;
    let question = bankQuestions.find((item) => item.id === questionId);
    let structure = question && readJson('questionBanks.json').find((item) => item.id === question.bankId);
    let file = 'bankQuestions.json';
    if (!question) {
      questions = challengeQuestions;
      question = challengeQuestions.find((item) => item.id === questionId);
      structure = question && readJson('challenges.json').find((item) => item.id === question.challengeId);
      file = 'challengeQuestions.json';
    }
    if (!question || !structure || !canOperateStructure(user, structure)) return sendJson(res, 404, { error: 'Question introuvable' });
    if (req.method === 'PATCH') {
      const patch = question.bankId ? sanitizeBankQuestion(await readBody(req), question.bankId) : sanitizeChallengeQuestion(await readBody(req), question.challengeId);
      Object.assign(question, patch, { id: question.id, bankId: question.bankId, challengeId: question.challengeId });
      writeJson(file, questions);
      return sendJson(res, 200, { question });
    }
    if (req.method === 'DELETE') {
      writeJson(file, questions.filter((item) => item.id !== question.id));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/publish')) {
      question.status = 'active';
      question.isActive = true;
      writeJson(file, questions);
      return sendJson(res, 200, { question });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/operator/challenges') {
    const challenges = readJson('challenges.json').filter((challenge) => canOperateStructure(user, challenge));
    sendJson(res, 200, { challenges });
    return;
  }

  const challengeQuestionsMatch = url.pathname.match(/^\/api\/operator\/challenges\/([^/]+)\/questions(?:\/(manual|generate-from-theme|generate-from-text))?$/);
  if (challengeQuestionsMatch) {
    const challenge = readJson('challenges.json').find((item) => item.id === decodeURIComponent(challengeQuestionsMatch[1]));
    if (!challenge || !canOperateStructure(user, challenge)) return sendJson(res, 403, { error: 'Challenge non autorise' });
    const method = challengeQuestionsMatch[2] || '';
    if (req.method === 'GET') {
      return sendJson(res, 200, { questions: readJson('challengeQuestions.json').filter((question) => question.challengeId === challenge.id) });
    }
    if (req.method === 'POST' && method === 'manual') {
      const questions = readJson('challengeQuestions.json');
      const question = sanitizeChallengeQuestion({ ...(await readBody(req)), status: 'active' }, challenge.id);
      question.id = `cq-${crypto.randomUUID()}`;
      questions.push(question);
      writeJson('challengeQuestions.json', questions);
      return sendJson(res, 201, { question });
    }
    if (req.method === 'POST' && ['generate-from-theme', 'generate-from-text'].includes(method)) {
      const generated = await generateOperatorDrafts(await readBody(req), method);
      const questions = readJson('challengeQuestions.json');
      const saved = generated.map((item) => ({ ...sanitizeChallengeQuestion({ ...item, status: 'draft' }, challenge.id), id: `cq-${crypto.randomUUID()}` }));
      writeJson('challengeQuestions.json', questions.concat(saved));
      return sendJson(res, 201, { questions: saved });
    }
  }

  sendJson(res, 404, { error: 'Route operator introuvable' });
}

async function handleRoomAction(req, res, match, url) {
  const roomId = decodeURIComponent(match[1]);
  const action = match[2];
  const code = url.searchParams.get('code');
  const room = findRoom(roomId, code);
  if (!room) return sendJson(res, 404, { error: 'Salon introuvable ou code invalide' });

  if (action === 'join' && req.method === 'POST') {
    const body = await readBody(req);
    const participant = joinRoom(room, body);
    sendJson(res, 200, { participant, room: withRoomDetails(room) });
    return;
  }

  if (action === 'leave' && req.method === 'POST') {
    const body = await readBody(req);
    const participant = leaveRoom(room.id, body.participantId);
    if (!participant) return sendJson(res, 404, { error: 'Participant introuvable' });
    sendJson(res, 200, { participant });
    return;
  }

  if ((action === 'start-round' || action === 'start') && req.method === 'POST') {
    const body = await readBody(req);
    const allowed = body.creatorId === room.creatorId || isAdmin(req);
    if (!allowed) return sendJson(res, 403, { error: 'Createur ou admin requis' });
    const now = new Date();
    if (room.isScheduled && new Date(room.scheduledStartAt) > now) {
      return sendJson(res, 409, { error: `La competition commence dans ${formatDuration(new Date(room.scheduledStartAt).getTime() - now.getTime())}.` });
    }
    if (new Date(room.endDate) <= now) return sendJson(res, 409, { error: 'Le creneau de competition est termine.' });
    const existingRound = currentRoundForRoom(room.id);
    if (existingRound && ['preparing_questions', 'starting_countdown', 'question_active', 'question_reveal', 'between_questions'].includes(existingRound.phase)) {
      sendJson(res, 200, buildRoomState(findRoom(room.id, code), body.participantId));
      return;
    }
    const round = createRound(room, 'preparing_questions');
    prepareRoundQuestions(room.id, round.id);
    sendJson(res, 202, buildRoomState(findRoom(room.id, code), body.participantId));
    return;
  }

  if (action === 'current-round' && req.method === 'GET') {
    const round = currentRoundForRoom(room.id);
    if (!round) return sendJson(res, 200, { round: null, questions: [] });
    const questions = readJson('roundQuestions.json')
      .filter((question) => question.roundId === round.id)
      .sort((a, b) => a.order - b.order)
      .map(withoutRoundAnswer);
    sendJson(res, 200, { round, questions });
    return;
  }

  if (action === 'leaderboard' && req.method === 'GET') {
    sendJson(res, 200, { leaderboard: roomLeaderboard(room.id) });
    return;
  }

  if (action === 'results' && req.method === 'GET') {
    sendJson(res, 200, { results: roomResults(room.id) });
    return;
  }

  if (action === 'close' && req.method === 'POST') {
    const body = await readBody(req);
    const allowed = body.creatorId === room.creatorId || isAdmin(req);
    if (!allowed) return sendJson(res, 403, { error: 'Createur ou admin requis' });
    const closed = updateRoomStatus(room.id, 'closed');
    sendJson(res, 200, { room: closed });
    return;
  }

  sendJson(res, 404, { error: 'Action salon introuvable' });
}

async function handleQuestionBankApi(req, res, match) {
  const bankId = match[1] ? decodeURIComponent(match[1]) : null;
  if (!bankId && req.method === 'GET') {
    const banks = readJson('questionBanks.json').filter((bank) => bank.isActive !== false && (bank.isPublic !== false || canManageBank(req, bank)));
    sendJson(res, 200, { questionBanks: banks });
    return;
  }
  if (!bankId && req.method === 'POST') {
    const user = requireRole(req, ['admin', 'operator']);
    if (!user) return sendJson(res, 403, { error: 'Role operator requis' });
    const bank = sanitizeQuestionBank(await readBody(req), user);
    const banks = readJson('questionBanks.json');
    bank.id = `qb-${crypto.randomUUID()}`;
    bank.createdAt = new Date().toISOString();
    bank.updatedAt = bank.createdAt;
    banks.push(bank);
    writeJson('questionBanks.json', banks);
    sendJson(res, 201, { questionBank: bank });
    return;
  }
  const banks = readJson('questionBanks.json');
  const bank = banks.find((item) => item.id === bankId);
  if (!bank) return sendJson(res, 404, { error: 'Banque introuvable' });
  if (req.method === 'GET') {
    if (bank.isPublic === false && !canManageBank(req, bank)) return sendJson(res, 403, { error: 'Acces refuse' });
    sendJson(res, 200, { questionBank: bank });
    return;
  }
  if (req.method === 'PATCH') {
    if (!canManageBank(req, bank)) return sendJson(res, 403, { error: 'Acces refuse' });
    Object.assign(bank, sanitizeQuestionBank(await readBody(req), currentUser(req) || { id: bank.createdBy }), { id: bank.id, createdBy: bank.createdBy, createdAt: bank.createdAt, updatedAt: new Date().toISOString() });
    writeJson('questionBanks.json', banks);
    sendJson(res, 200, { questionBank: bank });
    return;
  }
  if (req.method === 'DELETE') {
    if (!canManageBank(req, bank)) return sendJson(res, 403, { error: 'Acces refuse' });
    writeJson('questionBanks.json', banks.filter((item) => item.id !== bank.id));
    writeJson('bankQuestions.json', readJson('bankQuestions.json').filter((question) => question.bankId !== bank.id));
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 405, { error: 'Methode non autorisee' });
}

async function handleBankQuestionsApi(req, res, bankId) {
  const bank = readJson('questionBanks.json').find((item) => item.id === bankId);
  if (!bank) return sendJson(res, 404, { error: 'Banque introuvable' });
  if (req.method === 'GET') {
    if (bank.isPublic === false && !canManageBank(req, bank)) return sendJson(res, 403, { error: 'Acces refuse' });
    sendJson(res, 200, { questions: readJson('bankQuestions.json').filter((question) => question.bankId === bankId) });
    return;
  }
  if (req.method === 'POST') {
    if (!canManageBank(req, bank)) return sendJson(res, 403, { error: 'Acces refuse' });
    const questions = readJson('bankQuestions.json');
    const question = sanitizeBankQuestion(await readBody(req), bankId);
    question.id = `bq-${crypto.randomUUID()}`;
    questions.push(question);
    writeJson('bankQuestions.json', questions);
    sendJson(res, 201, { question });
    return;
  }
  sendJson(res, 405, { error: 'Methode non autorisee' });
}

async function handleBankQuestionItemApi(req, res, questionId) {
  const questions = readJson('bankQuestions.json');
  const question = questions.find((item) => item.id === questionId);
  if (!question) return sendJson(res, 404, { error: 'Question introuvable' });
  const bank = readJson('questionBanks.json').find((item) => item.id === question.bankId);
  if (!bank || !canManageBank(req, bank)) return sendJson(res, 403, { error: 'Acces refuse' });
  if (req.method === 'PATCH') {
    Object.assign(question, sanitizeBankQuestion(await readBody(req), question.bankId), { id: question.id, bankId: question.bankId });
    writeJson('bankQuestions.json', questions);
    sendJson(res, 200, { question });
    return;
  }
  if (req.method === 'DELETE') {
    writeJson('bankQuestions.json', questions.filter((item) => item.id !== question.id));
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 405, { error: 'Methode non autorisee' });
}

async function ensureAutoStart(room) {
  const fresh = refreshRoomStatus(room);
  if (!fresh.autoStart || fresh.status !== 'active') return;
  const activeRound = readJson('rounds.json').some((round) => round.roomId === fresh.id && round.status === 'active');
  if (activeRound) return;
  const round = createRound(fresh, 'preparing_questions');
  prepareRoundQuestions(fresh.id, round.id);
}

function sanitizeRoom(body) {
  const now = new Date();
  const isScheduled = body.isScheduled === true;
  const durationMinutes = clamp(Number(body.durationMinutes || body.roundTimeLimit || 30), 5, 240);
  const scheduledStart = body.scheduledStartAt ? new Date(body.scheduledStartAt) : now;
  const scheduledEnd = body.scheduledEndAt ? new Date(body.scheduledEndAt) : new Date(scheduledStart.getTime() + durationMinutes * 60 * 1000);
  const defaultStart = isScheduled ? scheduledStart : (body.startDate ? new Date(body.startDate) : now);
  const defaultEnd = isScheduled ? scheduledEnd : (body.endDate ? new Date(body.endDate) : new Date(defaultStart.getTime() + durationMinutes * 60 * 1000));
  return {
    id: sanitizeString(body.id || '').slice(0, 80),
    name: sanitizeString(body.name || 'Salon biblique').slice(0, 120),
    description: sanitizeString(body.description || '').slice(0, 500),
    category: sanitizeString(body.category || 'random').slice(0, 80),
    difficulty: sanitizeString(body.difficulty || body.level || 'intermediaire').slice(0, 80),
    creatorId: sanitizeString(body.creatorId || '').slice(0, 100),
    accessCode: sanitizeString(body.accessCode || '').slice(0, 24).toUpperCase(),
    isPublic: body.isPublic !== false,
    status: ['waiting', 'preparing_questions', 'starting_countdown', 'starting', 'question_active', 'question_reveal', 'between_questions', 'closed', 'finished'].includes(body.status) ? body.status : 'waiting',
    startDate: defaultStart.toISOString(),
    endDate: defaultEnd > defaultStart ? defaultEnd.toISOString() : new Date(defaultStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    isScheduled,
    scheduledStartAt: isScheduled ? defaultStart.toISOString() : null,
    scheduledEndAt: isScheduled ? (defaultEnd > defaultStart ? defaultEnd : new Date(defaultStart.getTime() + durationMinutes * 60 * 1000)).toISOString() : null,
    durationMinutes,
    autoStart: body.autoStart === true,
    questionTimeLimit: clamp(Number(body.questionTimeLimit || 30), 15, 60),
    roundTimeLimit: durationMinutes,
    questionsPerRound: clamp(Number(body.questionsPerRound || 10), 1, 20),
    questionMode: body.questionMode === 'personalized' ? 'personalized' : 'same',
    questionTypes: Array.isArray(body.questionTypes) && body.questionTypes.length
      ? body.questionTypes.filter((type) => questionTypes.includes(type)).slice(0, 8)
      : ['qcm', 'vrai_faux', 'personnage'],
    explanationsEnabled: body.explanationsEnabled !== false,
    questionSource: body.questionSource === 'local' ? 'local' : 'ai',
    questionBankId: sanitizeString(body.questionBankId || '').slice(0, 100),
    createdAt: body.createdAt || new Date().toISOString()
  };
}

function withRoomCounts(room) {
  const participants = readJson('roomParticipants.json').filter((item) => item.roomId === room.id && !item.leftAt);
  const rounds = readJson('rounds.json').filter((item) => item.roomId === room.id);
  return { ...room, participantCount: participants.length, roundCount: rounds.length };
}

function withRoomDetails(room) {
  return {
    ...withRoomCounts(room),
    participants: readJson('roomParticipants.json').filter((item) => item.roomId === room.id && !item.leftAt),
    rounds: readJson('rounds.json').filter((item) => item.roomId === room.id).sort((a, b) => a.roundNumber - b.roundNumber)
  };
}

function findRoom(idOrCode, code) {
  const rooms = readJson('rooms.json');
  const normalized = sanitizeString(idOrCode).toUpperCase();
  const room = rooms.find((item) => item.id === idOrCode || item.accessCode === normalized);
  if (!room) return null;
  if (!room.isPublic && code && room.accessCode !== sanitizeString(code).toUpperCase()) return null;
  if (!room.isPublic && !code && room.id !== idOrCode && room.accessCode !== normalized) return null;
  return refreshRoomStatus(room);
}

function refreshRoomStatus(room) {
  if (['closed', 'finished', 'preparing_questions', 'starting_countdown', 'starting', 'question_active', 'question_reveal', 'between_questions'].includes(room.status)) return room;
  const now = new Date();
  const startsAt = new Date(room.scheduledStartAt || room.startDate);
  const endsAt = new Date(room.scheduledEndAt || room.endDate);
  const status = now > endsAt ? 'finished' : (now >= startsAt ? 'active' : 'waiting');
  if (room.status !== status) {
    const rooms = readJson('rooms.json');
    const index = rooms.findIndex((item) => item.id === room.id);
    if (index !== -1) {
      rooms[index] = { ...rooms[index], status };
      writeJson('rooms.json', rooms);
    }
    return { ...room, status };
  }
  return room;
}

function joinRoom(room, body) {
  const participants = readJson('roomParticipants.json');
  const existing = body.participantId && participants.find((item) => item.id === body.participantId && item.roomId === room.id);
  if (existing) {
    existing.leftAt = null;
    writeJson('roomParticipants.json', participants);
    return existing;
  }
  const participant = {
    id: `rp-${crypto.randomUUID()}`,
    roomId: room.id,
    playerName: sanitizeString(body.playerName || 'Anonyme').slice(0, 40) || 'Anonyme',
    joinedAt: new Date().toISOString(),
    leftAt: null,
    totalScore: 0,
    roundsPlayed: 0
  };
  participants.push(participant);
  writeJson('roomParticipants.json', participants);
  return participant;
}

function leaveRoom(roomId, participantId) {
  const participants = readJson('roomParticipants.json');
  const participant = participants.find((item) => item.id === participantId && item.roomId === roomId);
  if (!participant) return null;
  participant.leftAt = new Date().toISOString();
  writeJson('roomParticipants.json', participants);
  return participant;
}

function createRound(room, phase = 'preparing_questions') {
  const rounds = readJson('rounds.json');
  const roomRounds = rounds.filter((item) => item.roomId === room.id);
  const startsAt = new Date();
  const round = {
    id: `round-${crypto.randomUUID()}`,
    roomId: room.id,
    roundNumber: roomRounds.length + 1,
    status: 'active',
    phase,
    gameStatus: phase === 'finished' ? 'game_finished' : phase,
    currentQuestionIndex: 0,
    questionStartedAt: null,
    questionEndsAt: null,
    countdownEndsAt: null,
    revealUntil: null,
    nextQuestionAt: null,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + room.roundTimeLimit * 60 * 1000).toISOString(),
    generatedByAI: room.questionSource !== 'local' && azureConfigured(),
    validationStatus: 'pending',
    createdAt: startsAt.toISOString()
  };
  rounds.push(round);
  writeJson('rounds.json', rounds);
  updateRoomStatus(room.id, phase);
  return round;
}

function currentRoundForRoom(roomId) {
  advanceRoomState(roomId);
  return readJson('rounds.json')
    .filter((round) => round.roomId === roomId && round.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function latestRoundForRoom(roomId) {
  return readJson('rounds.json')
    .filter((round) => round.roomId === roomId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function prepareRoundQuestions(roomId, roundId) {
  Promise.resolve().then(async () => {
    const room = readJson('rooms.json').find((item) => item.id === roomId);
    const round = readJson('rounds.json').find((item) => item.id === roundId);
    if (!room || !round || round.phase !== 'preparing_questions' || round.status !== 'active') return;
    try {
      const saved = await createQuestionsForRound(room, round);
      const validationStatus = readJson('rounds.json').find((item) => item.id === roundId)?.validationStatus || 'validated';
      const now = Date.now();
      setRoundPhase(roundId, {
        phase: 'starting_countdown',
        gameStatus: 'starting_countdown',
        currentQuestionIndex: 0,
        questionsReady: saved.length > 0,
        countdownEndsAt: new Date(now + 3000).toISOString(),
        nextQuestionAt: new Date(now + 3000).toISOString(),
        preparationMessage: validationStatus === 'fallback_local'
          ? 'La generation IA a echoue. Utilisation des questions locales de secours.'
          : 'Questions pretes.'
      });
      updateRoomStatus(roomId, 'starting_countdown');
    } catch (error) {
      setRoundPhase(roundId, {
        status: 'failed',
        phase: 'finished',
        gameStatus: 'game_finished',
        preparationMessage: error.message || 'Impossible de preparer les questions.'
      });
      updateRoomStatus(roomId, 'waiting');
      logAiError('prepare-round-questions', error.message || 'Preparation impossible');
    }
  });
}

function finishRound(roundId) {
  const rounds = readJson('rounds.json');
  const round = rounds.find((item) => item.id === roundId);
  if (!round) return null;
  round.status = 'finished';
  round.phase = 'finished';
  round.gameStatus = 'game_finished';
  writeJson('rounds.json', rounds);
  updateRoomStatus(round.roomId, 'finished');
  return round;
}

function advanceRoomState(roomId) {
  const rooms = readJson('rooms.json');
  const room = rooms.find((item) => item.id === roomId);
  if (!room || ['closed', 'finished'].includes(room.status)) return;
  let rounds = readJson('rounds.json');
  const round = rounds
    .filter((item) => item.roomId === roomId && item.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!round) {
    updateRoomStatus(roomId, 'waiting');
    return;
  }

  const questions = readJson('roundQuestions.json')
    .filter((question) => question.roundId === round.id)
    .sort((a, b) => a.order - b.order);
  const now = Date.now();

  if (now > new Date(round.endsAt).getTime()) {
    finalizeCurrentQuestion(room, round, questions);
    finishRound(round.id);
    return;
  }

  if (round.phase === 'preparing_questions') {
    return;
  }

  if ((round.phase === 'starting_countdown' || round.phase === 'starting') && now >= new Date(round.countdownEndsAt || round.nextQuestionAt).getTime()) {
    if (!questions.length) return;
    setRoundPhase(round.id, {
      phase: 'question_active',
      gameStatus: 'question_active',
      questionStartedAt: new Date(now).toISOString(),
      questionEndsAt: new Date(now + room.questionTimeLimit * 1000).toISOString(),
      countdownEndsAt: null,
      revealUntil: null,
      nextQuestionAt: null
    });
    updateRoomStatus(roomId, 'question_active');
    return;
  }

  if (round.phase === 'question_active' && now >= new Date(round.questionEndsAt).getTime()) {
    finalizeCurrentQuestion(room, round, questions);
    setRoundPhase(round.id, {
      phase: 'question_reveal',
      gameStatus: 'question_reveal',
      revealUntil: new Date(now + 4000).toISOString(),
      nextQuestionAt: new Date(now + 5000).toISOString()
    });
    updateRoomStatus(roomId, 'question_reveal');
    return;
  }

  if (round.phase === 'question_reveal' && now >= new Date(round.revealUntil).getTime()) {
    setRoundPhase(round.id, { phase: 'between_questions', gameStatus: 'between_questions' });
    updateRoomStatus(roomId, 'between_questions');
    return;
  }

  if (round.phase === 'between_questions' && now >= new Date(round.nextQuestionAt).getTime()) {
    const nextIndex = Number(round.currentQuestionIndex || 0) + 1;
    if (nextIndex >= questions.length) {
      finishRound(round.id);
      return;
    }
    setRoundPhase(round.id, {
      phase: 'question_active',
      gameStatus: 'question_active',
      currentQuestionIndex: nextIndex,
      questionStartedAt: new Date(now).toISOString(),
      questionEndsAt: new Date(now + room.questionTimeLimit * 1000).toISOString(),
      countdownEndsAt: null,
      revealUntil: null,
      nextQuestionAt: null
    });
    updateRoomStatus(roomId, 'question_active');
  }
}

function setRoundPhase(roundId, patch) {
  const rounds = readJson('rounds.json');
  const round = rounds.find((item) => item.id === roundId);
  if (!round) return null;
  Object.assign(round, patch);
  writeJson('rounds.json', rounds);
  return round;
}

function finalizeCurrentQuestion(room, round, questions) {
  const question = questions[Number(round.currentQuestionIndex || 0)];
  if (!question) return;
  const answers = readJson('answers.json');
  let changed = false;
  for (const answer of answers.filter((item) => item.roundId === round.id && item.questionId === question.id && !item.isFinalized)) {
    const isCorrect = normalize(answer.selectedAnswer) === normalize(question.correctAnswer);
    const questionTimeLimitMs = room.questionTimeLimit * 1000;
    const remaining = Math.max(0, questionTimeLimitMs - Number(answer.responseTimeMs || 0));
    answer.isCorrect = isCorrect;
    answer.basePoints = isCorrect ? 10 : 0;
    answer.speedBonus = isCorrect ? Math.round(10 * remaining / questionTimeLimitMs) : 0;
    answer.totalPoints = answer.basePoints + answer.speedBonus;
    answer.isFinalized = true;
    changed = true;
  }
  if (changed) writeJson('answers.json', answers);
  recalculateParticipantScores(room.id);
}

async function createQuestionsForRound(room, round) {
  const roundQuestions = readJson('roundQuestions.json').filter((item) => item.roundId !== round.id);
  const generated = await generateRoundQuestions({
    roomId: room.id,
    roundId: round.id,
    category: room.category,
    difficulty: room.difficulty,
    count: room.questionsPerRound,
    questionTypes: room.questionTypes || ['qcm', 'vrai_faux', 'personnage'],
    questionSource: room.questionSource || 'ai',
    questionBankId: room.questionBankId,
    recentQuestions: recentRoomQuestionTexts(room.id)
  });
  const saved = generated.questions.map((question, index) => sanitizeRoundQuestion({
    ...question,
    id: `rq-${crypto.randomUUID()}`,
    roundId: round.id,
    category: question.category || room.category,
    difficulty: question.difficulty || question.level || room.difficulty,
    order: index + 1
  }));
  writeJson('roundQuestions.json', roundQuestions.concat(saved));
  recordGeneratedQuestions(saved, generated.validationStatus === 'local_selected' || generated.validationStatus === 'fallback_local' ? 'local' : 'AI');
  setRoundValidation(round.id, generated.validationStatus || 'validated');
  if (generated.validationStatus === 'fallback_local') {
    setRoundPhase(round.id, { preparationMessage: 'La generation IA a echoue. Utilisation des questions locales de secours.' });
  }
  return saved;
}

async function createStartGame(body, count) {
  const category = validId(body.category, categories, 'random');
  const level = normalizeLevelId(body.level);
  const playerName = sanitizeString(body.playerName || 'Anonyme').slice(0, 40) || 'Anonyme';
  const clientRecentQuestions = Array.isArray(body.recentQuestions)
    ? body.recentQuestions.map((item) => typeof item === 'string' ? { question: item } : item).slice(-50)
    : [];
  const recentQuestions = clientRecentQuestions.concat(recentPlayerQuestionHistory(playerName, level, 60));
  const gameSessionId = `game-${crypto.randomUUID()}`;
  const generated = await generateRoundQuestions({
    gameSessionId,
    category,
    difficulty: level,
    level,
    count,
    questionTypes: ['qcm', 'vrai_faux', 'personnage', 'livre_biblique', 'completer_verset', 'qui_suis_je', 'contexte_historique'],
    questionSource: 'ai',
    challengeType: 'progression_commencer',
    participantLevel: level,
    recentQuestions
  });
  const saved = generated.questions.map((question, index) => sanitizeRoundQuestion({
    ...question,
    id: `gq-${crypto.randomUUID()}`,
    roundId: gameSessionId,
    category: question.category || category,
    difficulty: question.difficulty || question.level || level,
    level: question.level || question.difficulty || level,
    order: index + 1
  }));
  appendStartGameQuestions(gameSessionId, playerName, saved);
  recordGeneratedQuestions(saved, generated.validationStatus === 'fallback_local' ? 'local' : 'AI');
  recordPlayerQuestionHistory(playerName, category, level, saved);
  return { gameSessionId, questions: saved };
}

async function generateRoundQuestions(input) {
  const count = clamp(Number(input.count || 10), 1, 20);
  if (input.questionSource === 'local') {
    if (!input.questionBankId) throw new Error('Choisissez une banque de questions locales.');
    const localPool = selectBankQuestions(input.questionBankId, count);
    if (localPool.length < count) {
      throw new Error(`La banque locale ne contient que ${localPool.length} question(s) active(s) pour ${count} demandee(s).`);
    }
    return {
      questions: localPool.slice(0, count).map((question) => ({
        ...question,
        difficulty: question.difficulty || question.level,
        aiValidationStatus: 'local_selected',
        aiValidationNotes: 'Question locale choisie pour le salon'
      })),
      validationStatus: 'local_selected',
      validation: { results: [] }
    };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let generated = [];
    try {
      generated = await generateCompetitionQuestions(input, count);
    } catch (error) {
      lastError = `Tentative ${attempt}: ${error.message}`;
      logAiError('generate-round-questions', lastError);
      continue;
    }
    const validation = await validateQuestionsWithAI(generated, input);
    const validQuestions = generated.filter((question, index) => validation.results[index]?.valid && !isDuplicateQuestion(question, input.recentQuestions || []));
    if (validQuestions.length >= count) {
      return { questions: validQuestions.slice(0, count), validationStatus: 'validated', validation };
    }
    lastError = `Tentative ${attempt}: ${validQuestions.length}/${count} questions valides`;
  }
  logAiError('generate-round-questions', lastError || 'Generation incomplete');
  return {
    questions: selectQuestions(input.category, input.difficulty || input.level, count, { avoidQuestions: input.recentQuestions || [] }).map((question) => ({
      ...question,
      difficulty: question.level,
      aiValidationStatus: 'fallback_local',
      aiValidationNotes: 'Question locale de secours'
    })),
    validationStatus: 'fallback_local',
    validation: { results: [] }
  };
}

function selectBankQuestions(bankId, count) {
  const bank = readJson('questionBanks.json').find((item) => item.id === bankId && item.isActive !== false);
  if (!bank) return [];
  const questions = readJson('bankQuestions.json').filter((question) => question.bankId === bank.id && question.isActive !== false);
  return shuffle(questions).slice(0, count);
}

function appendStartGameQuestions(gameSessionId, playerName, questions) {
  const all = readJson('gameQuestions.json')
    .filter((item) => Date.now() - new Date(item.createdAt || 0).getTime() < 7 * 24 * 60 * 60 * 1000);
  const createdAt = new Date().toISOString();
  writeJson('gameQuestions.json', all.concat(questions.map((question) => ({
    ...question,
    gameSessionId,
    playerName,
    createdAt
  }))));
}

function recentPlayerQuestionHistory(playerName, level, limit = 50) {
  const key = playerHistoryKey(playerName);
  const levelRank = difficultyRank(normalizeLevelId(level));
  return readJson('playerQuestionHistory.json')
    .filter((item) => item.playerKey === key && Math.abs(difficultyRank(normalizeLevelId(item.level)) - levelRank) <= 1)
    .sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt))
    .slice(0, limit)
    .map((item) => ({ question: item.question, correctAnswer: item.correctAnswer, level: item.level }));
}

function recordPlayerQuestionHistory(playerName, category, level, questions) {
  const key = playerHistoryKey(playerName);
  const kept = readJson('playerQuestionHistory.json')
    .filter((item) => item.playerKey !== key)
    .concat(readJson('playerQuestionHistory.json')
      .filter((item) => item.playerKey === key)
      .sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt))
      .slice(0, 80));
  const playedAt = new Date().toISOString();
  const additions = questions.map((question) => ({
    id: `pqh-${crypto.randomUUID()}`,
    playerKey: key,
    category,
    level,
    questionId: question.id,
    question: sanitizeString(question.question).slice(0, 500),
    correctAnswer: sanitizeString(question.correctAnswer || '').slice(0, 180),
    playedAt
  }));
  writeJson('playerQuestionHistory.json', kept.concat(additions).slice(-5000));
}

function playerHistoryKey(playerName) {
  return crypto.createHash('sha256').update(`player:${normalize(playerName || 'Anonyme')}`).digest('hex');
}

async function generateCompetitionQuestions(input, count) {
  if (!azureConfigured()) {
    return selectQuestions(input.category, input.difficulty || input.level, count, { avoidQuestions: input.recentQuestions || [] }).map((question) => ({
      ...question,
      difficulty: question.level,
      justification: 'Fallback local'
    }));
  }
  const payload = await callAzureJson([
    {
      role: 'system',
      content: [
        'Tu es un generateur expert de quiz biblique pour une competition. Genere des questions adaptees a la categorie, au niveau de difficulte et au type de challenge. Chaque question doit avoir une seule bonne reponse, quatre options plausibles, une explication courte et une reference biblique quand possible. Evite les debats doctrinaux. Retourne uniquement du JSON valide.',
        aiAntiRepetitionInstruction,
        isScholarLevel(input.difficulty || input.level) ? scholarInstruction : ''
      ].filter(Boolean).join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({
        category: input.category,
        difficulty: input.difficulty || input.level,
        difficultyGuidance: difficultyGuidance(input.difficulty || input.level),
        challengeType: input.challengeType || 'competition',
        count,
        participantLevel: input.participantLevel || null,
        recentQuestions: input.recentQuestions || [],
        recentlyGeneratedQuestions: recentGeneratedQuestionTexts(input.category, input.difficulty || input.level, 80),
        avoidDuplicateRules: [
          'rejeter les textes quasi identiques',
          'eviter meme reponse et meme structure',
          'eviter une variation trop faible d une question recente',
          'eviter trop de questions sur le meme personnage ou le meme livre',
          'ne pas generer de questions identiques ou quasi identiques aux niveaux precedents',
          'adapter fortement la profondeur au niveau demande'
        ],
        difficultySeparation: difficultySeparationRules(input.difficulty || input.level),
        rotationTopics,
        output: {
          questions: [{
            question: 'string',
            type: 'qcm',
            options: ['string', 'string', 'string', 'string'],
            correctAnswer: 'string',
            explanation: 'string',
            reference: 'string',
            historicalNote: 'string optionnel, separe du texte biblique direct',
            level: input.difficulty || input.level,
            category: input.category,
            justification: 'string'
          }]
        }
      })
    }
  ]);
  return (Array.isArray(payload.questions) ? payload.questions : []).map((question) => sanitizeQuestion({
    ...question,
    level: question.level || question.difficulty || input.difficulty,
    category: question.category || input.category,
    isActive: true
  })).filter(validateQuestion);
}

async function validateQuestionsWithAI(questions, input = {}) {
  const localResults = questions.map((question) => {
    const valid = validateQuestion(sanitizeQuestion(question)) && !isDuplicateQuestion(question, input.recentQuestions || []);
    return {
      valid,
      reason: valid ? 'Validation locale OK' : 'Question invalide, ambigue ou doublon recent',
      correctedQuestion: null
    };
  });
  if (!azureConfigured() || !questions.length) {
    return { results: localResults, source: 'local' };
  }
  try {
    const payload = await callAzureJson([
      {
        role: 'system',
        content: 'Tu es un validateur de qualite pour un quiz biblique. Analyse chaque question et verifie qu elle est claire, non ambigue, bibliquement coherente, adaptee au niveau demande, avec une seule bonne reponse. Rejette les doublons, les questions quasi identiques, les formulations trop generiques et les speculations presentees comme certitudes. Pour Scholar, verifie que le texte biblique direct est distingue du contexte historique ou culturel. Retourne pour chaque question : valid true/false, reason, correctedQuestion si necessaire.'
      },
      { role: 'user', content: JSON.stringify({ questions, difficulty: input.difficulty || input.level, category: input.category, recentlyGeneratedQuestions: recentGeneratedQuestionTexts(input.category, input.difficulty || input.level, 80) }) }
    ]);
    const results = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.questions) ? payload.questions : [];
    return { results: questions.map((_, index) => ({
      valid: Boolean(results[index]?.valid) && localResults[index].valid,
      reason: sanitizeString(results[index]?.reason || localResults[index].reason).slice(0, 300),
      correctedQuestion: results[index]?.correctedQuestion || null
    })), source: 'azure' };
  } catch (error) {
    logAiError('validate-questions', error.message);
    return { results: localResults, source: 'local_after_error' };
  }
}

async function callAzureJson(messages) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '');
  const deployment = encodeURIComponent(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion = encodeURIComponent(process.env.AZURE_OPENAI_API_VERSION);
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY },
    body: JSON.stringify({ messages, temperature: 0.45, response_format: { type: 'json_object' } })
  });
  if (!response.ok) throw new Error(`Azure OpenAI HTTP ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content || '{}');
}

function sanitizeRoundQuestion(body) {
  const question = shuffleQuestionOptions(sanitizeQuestion(body));
  return {
    id: body.id || `rq-${crypto.randomUUID()}`,
    roundId: sanitizeString(body.roundId || '').slice(0, 100),
    question: question.question,
    type: question.type,
    options: question.options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    historicalNote: question.historicalNote,
    reference: question.reference,
    category: question.category,
    difficulty: sanitizeString(body.difficulty || question.level).slice(0, 80),
    aiValidationStatus: sanitizeString(body.aiValidationStatus || 'validated').slice(0, 80),
    aiValidationNotes: sanitizeString(body.aiValidationNotes || body.justification || '').slice(0, 300),
    order: Number(body.order || 0)
  };
}

function withoutRoundAnswer(question) {
  const { correctAnswer, ...safe } = question;
  return safe;
}

function submitRoundAnswer(roundId, body) {
  const initialRound = readJson('rounds.json').find((item) => item.id === roundId);
  if (initialRound) advanceRoomState(initialRound.roomId);
  const round = readJson('rounds.json').find((item) => item.id === roundId);
  if (!round) return { error: 'Tour introuvable', status: 404 };
  if (round.status !== 'active' || round.phase !== 'question_active') return { error: 'Les reponses sont fermees pour cette phase', status: 409 };
  const questions = readJson('roundQuestions.json')
    .filter((item) => item.roundId === roundId)
    .sort((a, b) => a.order - b.order);
  const question = questions[Number(round.currentQuestionIndex || 0)];
  if (!question || question.id !== body.questionId) return { error: 'Question non active', status: 409 };
  if (!question) return { error: 'Question introuvable', status: 404 };
  const participants = readJson('roomParticipants.json');
  const participant = participants.find((item) => item.id === body.participantId && item.roomId === round.roomId && !item.leftAt);
  if (!participant) return { error: 'Participant introuvable', status: 404 };
  const answers = readJson('answers.json');
  const responseTimeMs = clamp(Date.now() - new Date(round.questionStartedAt).getTime(), 0, 60 * 1000);
  const selectedAnswer = sanitizeString(body.selectedAnswer || '').slice(0, 180);
  const existingAnswer = answers.find((answer) => answer.roundId === roundId && answer.questionId === question.id && answer.participantId === participant.id);
  if (existingAnswer) {
    existingAnswer.selectedAnswer = selectedAnswer;
    existingAnswer.responseTimeMs = responseTimeMs;
    existingAnswer.answeredAt = new Date().toISOString();
    existingAnswer.isCorrect = false;
    existingAnswer.basePoints = 0;
    existingAnswer.speedBonus = 0;
    existingAnswer.totalPoints = 0;
    existingAnswer.isFinalized = false;
    writeJson('answers.json', answers);
    return {
      accepted: true,
      updated: true,
      answer: existingAnswer,
      state: buildRoomState(readJson('rooms.json').find((item) => item.id === round.roomId), participant.id)
    };
  }
  const answer = {
    id: `ans-${crypto.randomUUID()}`,
    roundId,
    questionId: question.id,
    participantId: participant.id,
    selectedAnswer,
    isCorrect: false,
    responseTimeMs,
    basePoints: 0,
    speedBonus: 0,
    totalPoints: 0,
    isFinalized: false,
    answeredAt: new Date().toISOString()
  };
  answers.push(answer);
  writeJson('answers.json', answers);
  return {
    accepted: true,
    answer,
    state: buildRoomState(readJson('rooms.json').find((item) => item.id === round.roomId), participant.id)
  };
}

function recalculateParticipantScores(roomId) {
  const participants = readJson('roomParticipants.json');
  const rounds = readJson('rounds.json').filter((round) => round.roomId === roomId).map((round) => round.id);
  const answers = readJson('answers.json').filter((answer) => rounds.includes(answer.roundId));
  for (const participant of participants.filter((item) => item.roomId === roomId)) {
    const participantAnswers = answers.filter((answer) => answer.participantId === participant.id);
    participant.totalScore = participantAnswers.reduce((sum, answer) => sum + answer.totalPoints, 0);
    participant.roundsPlayed = new Set(participantAnswers.map((answer) => answer.roundId)).size;
  }
  writeJson('roomParticipants.json', participants);
}

function buildRoomState(roomInput, participantId) {
  if (!roomInput) return null;
  advanceRoomState(roomInput.id);
  const room = readJson('rooms.json').find((item) => item.id === roomInput.id) || roomInput;
  const participants = readJson('roomParticipants.json').filter((item) => item.roomId === room.id && !item.leftAt);
  const participant = participants.find((item) => item.id === participantId) || null;
  const round = currentRoundForRoom(room.id);
  const questions = round
    ? readJson('roundQuestions.json').filter((item) => item.roundId === round.id).sort((a, b) => a.order - b.order)
    : [];
  const currentQuestion = round ? questions[Number(round.currentQuestionIndex || 0)] : null;
  const answers = readJson('answers.json');
  const currentAnswer = round && currentQuestion && participant
    ? answers.find((item) => item.roundId === round.id && item.questionId === currentQuestion.id && item.participantId === participant.id)
    : null;
  const now = Date.now();
  const phase = round?.phase || room.status || 'waiting';
  const timeRemainingMs = timeRemainingForPhase(round, phase, now);
  const phaseEndsAt = phaseEndTimeForPhase(round, phase);
  const countdownSeconds = Math.max(0, Math.ceil(timeRemainingMs / 1000));
  const revealQuestion = ['question_reveal', 'between_questions', 'finished'].includes(phase);
  const safeQuestion = currentQuestion ? {
    id: currentQuestion.id,
    question: currentQuestion.question,
    type: currentQuestion.type,
    options: currentQuestion.options,
    explanation: revealQuestion && room.explanationsEnabled !== false ? currentQuestion.explanation : undefined,
    historicalNote: revealQuestion && room.explanationsEnabled !== false ? currentQuestion.historicalNote : undefined,
    reference: revealQuestion ? currentQuestion.reference : undefined,
    correctAnswer: revealQuestion ? currentQuestion.correctAnswer : undefined
  } : null;
  return {
    room: withRoomDetails(room),
    participant,
    participants,
    round,
    phase,
    currentQuestion: safeQuestion,
    currentAnswer: currentAnswer ? {
      selectedAnswer: currentAnswer.selectedAnswer,
      isFinalized: currentAnswer.isFinalized,
      totalPoints: currentAnswer.totalPoints,
      isCorrect: currentAnswer.isCorrect
    } : null,
    serverNow: new Date(now).toISOString(),
    phaseEndsAt: phaseEndsAt ? new Date(phaseEndsAt).toISOString() : null,
    questionsReady: Boolean(round && questions.length > 0 && phase !== 'preparing_questions'),
    countdownEndsAt: round?.countdownEndsAt || (phase === 'starting_countdown' ? round?.nextQuestionAt : null) || null,
    questionStartedAt: round?.questionStartedAt || null,
    questionEndsAt: round?.questionEndsAt || null,
    currentQuestionIndex: round ? Number(round.currentQuestionIndex || 0) : 0,
    preparationMessage: round?.preparationMessage || null,
    timeRemainingMs,
    countdownSeconds,
    score: participant?.totalScore || 0,
    leaderboard: roomLeaderboard(room.id),
    results: phase === 'finished' ? roomResults(room.id) : null,
    questionIndex: round ? Number(round.currentQuestionIndex || 0) : 0,
    totalQuestions: questions.length
  };
}

function timeRemainingForPhase(round, phase, now) {
  if (!round) return 0;
  const endTime = phaseEndTimeForPhase(round, phase);
  return endTime ? Math.max(0, endTime - now) : 0;
}

function phaseEndTimeForPhase(round, phase) {
  if (!round) return 0;
  if ((phase === 'starting_countdown' || phase === 'starting') && (round.countdownEndsAt || round.nextQuestionAt)) return new Date(round.countdownEndsAt || round.nextQuestionAt).getTime();
  if (phase === 'question_active' && round.questionEndsAt) return new Date(round.questionEndsAt).getTime();
  if (phase === 'question_reveal' && round.revealUntil) return new Date(round.revealUntil).getTime();
  if (phase === 'between_questions' && round.nextQuestionAt) return new Date(round.nextQuestionAt).getTime();
  return 0;
}

function roomLeaderboard(roomId) {
  recalculateParticipantScores(roomId);
  return readJson('roomParticipants.json')
    .filter((item) => item.roomId === roomId && !item.leftAt)
    .sort((a, b) => b.totalScore - a.totalScore || a.joinedAt.localeCompare(b.joinedAt))
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function roomResults(roomId) {
  recalculateParticipantScores(roomId);
  const participants = readJson('roomParticipants.json').filter((item) => item.roomId === roomId);
  const roundIds = readJson('rounds.json').filter((round) => round.roomId === roomId).map((round) => round.id);
  const answers = readJson('answers.json').filter((answer) => roundIds.includes(answer.roundId) && answer.isFinalized);
  const players = participants.map((participant) => {
    const participantAnswers = answers.filter((answer) => answer.participantId === participant.id);
    const correctAnswers = participantAnswers.filter((answer) => answer.isCorrect).length;
    const averageResponseTimeMs = participantAnswers.length
      ? Math.round(participantAnswers.reduce((sum, answer) => sum + Number(answer.responseTimeMs || 0), 0) / participantAnswers.length)
      : 0;
    return {
      participantId: participant.id,
      playerName: participant.playerName,
      totalScore: participant.totalScore || 0,
      correctAnswers,
      totalAnswers: participantAnswers.length,
      averageResponseTimeMs,
      leftAt: participant.leftAt || null
    };
  }).sort((a, b) => b.totalScore - a.totalScore || b.correctAnswers - a.correctAnswers || a.averageResponseTimeMs - b.averageResponseTimeMs);
  return {
    roomId,
    status: 'game_finished',
    winner: players[0] || null,
    players: players.map((player, index) => ({ rank: index + 1, ...player }))
  };
}

function updateRoomStatus(roomId, status) {
  const rooms = readJson('rooms.json');
  const room = rooms.find((item) => item.id === roomId);
  if (!room) return null;
  room.status = status;
  writeJson('rooms.json', rooms);
  return room;
}

function setRoundValidation(roundId, validationStatus) {
  const rounds = readJson('rounds.json');
  const round = rounds.find((item) => item.id === roundId);
  if (round) {
    round.validationStatus = validationStatus;
    writeJson('rounds.json', rounds);
  }
}

function deleteRoom(roomId) {
  writeJson('rooms.json', readJson('rooms.json').filter((item) => item.id !== roomId));
  writeJson('roomParticipants.json', readJson('roomParticipants.json').filter((item) => item.roomId !== roomId));
  const roundIds = readJson('rounds.json').filter((item) => item.roomId === roomId).map((round) => round.id);
  writeJson('rounds.json', readJson('rounds.json').filter((item) => item.roomId !== roomId));
  writeJson('roundQuestions.json', readJson('roundQuestions.json').filter((item) => !roundIds.includes(item.roundId)));
  writeJson('answers.json', readJson('answers.json').filter((item) => !roundIds.includes(item.roundId)));
}

function recentRoomQuestionTexts(roomId) {
  const roundIds = readJson('rounds.json').filter((round) => round.roomId === roomId).map((round) => round.id);
  return readJson('roundQuestions.json')
    .filter((question) => roundIds.includes(question.roundId))
    .slice(-80)
    .map((question) => question.question);
}

function isRecentDuplicate(question, recentQuestions) {
  return isDuplicateQuestion(question, recentQuestions);
}

function isDuplicateQuestion(question, recentQuestions = []) {
  const history = readJson('generatedQuestionsHistory.json');
  const candidates = [
    ...recentQuestions.map((recent) => typeof recent === 'string' ? { rawQuestion: recent } : recent),
    ...history.slice(-300)
  ];
  return candidates.some((candidate) => questionsAreSimilar(question, candidate));
}

function questionsAreSimilar(question, candidate) {
  const left = normalizedQuestionText(question.question || question.rawQuestion || '');
  const right = normalizedQuestionText(candidate.question || candidate.rawQuestion || candidate.normalizedQuestion || '');
  if (!left || !right) return false;
  if (left === right) return true;
  if (stringSimilarity(left, right) >= 0.9) return true;

  const leftAnswer = normalizeAnswer(question.correctAnswer);
  const rightAnswer = normalizeAnswer(candidate.correctAnswer);
  if (leftAnswer && rightAnswer && leftAnswer === rightAnswer) {
    if (questionStructure(left) === questionStructure(right)) return true;
    if (stringSimilarity(left, right) >= 0.72) return true;
  }
  return false;
}

function recordGeneratedQuestions(questions, source = 'AI') {
  if (!Array.isArray(questions) || !questions.length) return;
  const history = readJson('generatedQuestionsHistory.json');
  const now = new Date().toISOString();
  for (const question of questions) {
    const normalizedQuestion = normalizedQuestionText(question.question);
    if (!normalizedQuestion) continue;
    if (history.some((item) => item.normalizedQuestion === normalizedQuestion)) continue;
    history.push({
      id: `gqh-${crypto.randomUUID()}`,
      normalizedQuestion,
      rawQuestion: sanitizeString(question.question).slice(0, 500),
      correctAnswer: sanitizeString(question.correctAnswer || '').slice(0, 180),
      category: sanitizeString(question.category || '').slice(0, 80),
      difficulty: sanitizeString(question.difficulty || question.level || '').slice(0, 80),
      generatedAt: now,
      source,
      hash: crypto.createHash('sha256').update(normalizedQuestion).digest('hex')
    });
  }
  writeJson('generatedQuestionsHistory.json', history.slice(-2000));
}

function recentGeneratedQuestionTexts(category, difficulty, limit = 60) {
  const normalizedCategory = normalize(category || '');
  const normalizedDifficulty = normalize(difficulty || '');
  return readJson('generatedQuestionsHistory.json')
    .filter((item) => {
      const sameCategory = !normalizedCategory || normalize(item.category) === normalizedCategory;
      const sameDifficulty = !normalizedDifficulty || normalize(item.difficulty) === normalizedDifficulty;
      return sameCategory || sameDifficulty;
    })
    .slice(-limit)
    .map((item) => item.rawQuestion);
}

function normalizedQuestionText(value) {
  return normalize(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAnswer(value) {
  return normalizedQuestionText(value || '');
}

function questionStructure(value) {
  return value
    .replace(/\b(qui|que|quoi|quel|quelle|quels|quelles|quand|ou|comment|pourquoi|dans|selon|apres|avant)\b/g, '?')
    .replace(/\b[a-z0-9]{4,}\b/g, '*')
    .replace(/\s+/g, ' ')
    .trim();
}

function stringSimilarity(left, right) {
  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 2));
  const rightTokens = new Set(right.split(' ').filter((token) => token.length > 2));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function isScholarLevel(level) {
  return normalize(level) === 'scholar';
}

function normalizeLevelId(level) {
  const value = normalize(level || '');
  if (['debutant', 'debutants', 'beginner'].includes(value)) return 'debutant';
  if (['intermediaire', 'intermediate'].includes(value)) return 'intermediaire';
  if (['avance', 'advanced'].includes(value)) return 'avance';
  if (value === 'expert') return 'expert';
  if (value === 'scholar') return 'scholar';
  return 'debutant';
}

function difficultyRank(level) {
  return { debutant: 1, intermediaire: 2, avance: 3, expert: 4, scholar: 5 }[normalizeLevelId(level)] || 1;
}

function difficultyGuidance(level) {
  const normalized = normalizeLevelId(level);
  const guidance = {
    debutant: {
      label: 'Debutant',
      depth: 'questions simples et directes',
      include: ['personnages tres connus', 'evenements majeurs', 'recits fondateurs', 'vocabulaire courant'],
      avoid: ['pieges subtils', 'contexte historique avance', 'symboles prophetiques complexes']
    },
    intermediaire: {
      label: 'Intermediaire',
      depth: 'details supplementaires, livres bibliques et chronologie simple',
      include: ['livres', 'ordre general des evenements', 'details visibles du texte', 'personnages secondaires connus'],
      avoid: ['questions trop evidentes de niveau debutant', 'analyses historiques specialisees']
    },
    avance: {
      label: 'Avance',
      depth: 'liens entre passages, contexte litteraire et details moins connus',
      include: ['paralleles entre textes', 'contexte d un passage', 'details moins memorises', 'themes bibliques transversaux'],
      avoid: ['questions de simple reconnaissance', 'pieges purement triviaux']
    },
    expert: {
      label: 'Expert',
      depth: 'propheties, geographie, symboles et analyse biblique poussee',
      include: ['symboles', 'geographie biblique', 'propheties', 'comparaison de passages', 'allusions textuelles'],
      avoid: ['questions trop simples', 'personnages connus sans angle analytique', 'memes questions que debutant/intermediaire']
    },
    scholar: {
      label: 'Scholar',
      depth: 'Bible d etude, chronologie avancee, histoire et culture antique',
      audience: 'etudiants serieux de la Bible, Bibles d etude, contexte historique, culture hebraique et greco-romaine, theologie introductive',
      include: scholarTopics,
      avoid: [
        'doctrines controversees',
        'debats confessionnels',
        'fausses informations historiques',
        'speculation presentee comme certitude',
        'questions ambigues',
        'questions qui pourraient convenir a debutant ou intermediaire'
      ],
      requiredFields: [
        'reponse',
        'explication',
        'reference biblique',
        'note historique separee quand utile'
      ]
    }
  };
  return guidance[normalized];
}

function difficultySeparationRules(level) {
  const normalized = normalizeLevelId(level);
  return {
    requestedLevel: normalized,
    rule: 'Utilise un pool mental distinct pour ce niveau. Une question debutant ne doit presque jamais apparaitre en expert; une question expert ne doit pas apparaitre en debutant.',
    beginner: 'personnages connus, evenements majeurs, consignes simples',
    intermediate: 'details supplementaires, livres, chronologie simple',
    advanced: 'liens entre passages, contexte, details moins connus',
    expert: 'propheties, geographie, symboles, analyse plus poussee',
    scholar: 'contexte historique, empires, culture antique, Bible d etude, chronologie avancee',
    strictness: ['expert', 'scholar'].includes(normalized)
      ? 'Interdire les questions trop simples et les reformulations des niveaux precedents.'
      : 'Rester adapte au niveau sans importer des questions des niveaux superieurs.'
  };
}

function logAiError(scope, message) {
  appendJson('aiErrors.json', {
    id: `aie-${crypto.randomUUID()}`,
    scope,
    message: sanitizeString(message || 'Erreur IA').slice(0, 500),
    createdAt: new Date().toISOString()
  });
}

function createAccessCode(existingRooms = readJson('rooms.json')) {
  const used = new Set(existingRooms.map((room) => room.accessCode));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = `BIBLE-${crypto.randomInt(100, 1000)}`;
    if (!used.has(code)) return code;
  }
  return `BIBLE-${crypto.randomInt(1000, 10000)}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), `${JSON.stringify(data, null, 2)}\n`);
}

function appendJson(file, item) {
  const data = readJson(file);
  data.push(item);
  writeJson(file, data);
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === '/' || pathname === '/admin' || pathname === '/operator' || pathname === '/login' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(fullPath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(fullPath) });
    res.end(content);
  });
}

function contentType(file) {
  const ext = path.extname(file);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg'
  }[ext] || 'application/octet-stream';
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
  });
}

function selectQuestions(category, level, count, options = {}) {
  const normalizedLevel = normalizeLevelId(level);
  const avoidQuestions = Array.isArray(options.avoidQuestions) ? options.avoidQuestions : [];
  const exactAvoidTexts = new Set(avoidQuestions.map((question) => normalizedQuestionText(question.question || question.rawQuestion || question.normalizedQuestion || question)).filter(Boolean));
  const questions = readJson('questions.json').filter((q) => q.isActive !== false);
  const filtered = questions.filter((q) => {
    const categoryOk = !category || category === 'random' || q.category === category || broadCategoryMatch(category, q.category);
    const levelOk = normalizeLevelId(q.level) === normalizedLevel;
    return categoryOk && levelOk;
  });
  const sameLevel = questions.filter((q) => normalizeLevelId(q.level) === normalizedLevel);
  const localFallback = localDifficultyFallbackQuestions(normalizedLevel, category);
  const selected = [];
  for (const pool of [filtered, sameLevel, localFallback]) {
    for (const question of shuffle(pool)) {
      if (selected.length >= count) break;
      if (selected.some((item) => isDuplicateQuestion(question, [item]))) continue;
      if (exactAvoidTexts.has(normalizedQuestionText(question.question))) continue;
      if (avoidQuestions.length && isDuplicateQuestion(question, avoidQuestions)) continue;
      selected.push(question);
    }
  }
  if (selected.length < count) {
    for (const question of shuffle(localFallback.concat(sameLevel))) {
      if (selected.length >= count) break;
      if (exactAvoidTexts.has(normalizedQuestionText(question.question))) continue;
      if (!selected.some((item) => item.id === question.id)) selected.push(question);
    }
  }
  return selected.slice(0, count);
}

function localDifficultyFallbackQuestions(level, category) {
  const normalizedLevel = normalizeLevelId(level);
  const pools = {
    debutant: [
      ['Qui a construit l arche avant le deluge ?', ['Noe', 'Moise', 'David', 'Jonas'], 'Noe', 'Noe construit l arche selon l ordre de Dieu.', 'Genese 6'],
      ['Qui a ete jete dans la fosse aux lions ?', ['Daniel', 'Joseph', 'Elie', 'Pierre'], 'Daniel', 'Daniel est preserve dans la fosse aux lions.', 'Daniel 6'],
      ['Dans quel jardin Adam et Eve sont-ils places ?', ['Eden', 'Gethsemane', 'Carmel', 'Sinai'], 'Eden', 'Le recit de la creation place Adam et Eve dans le jardin d Eden.', 'Genese 2'],
      ['Qui est la mere de Jesus ?', ['Marie', 'Marthe', 'Ruth', 'Debora'], 'Marie', 'Les evangiles presentent Marie comme la mere de Jesus.', 'Luc 1-2'],
      ['Jesus nourrit une foule avec cinq pains et deux poissons.', ['Vrai', 'Faux'], 'Vrai', 'Les evangiles rapportent ce miracle de multiplication.', 'Marc 6:30-44'],
      ['Qui a recu les dix commandements au Sinai ?', ['Moise', 'Samuel', 'Esdras', 'Timothee'], 'Moise', 'Moise recoit la loi pour Israel au Sinai.', 'Exode 20'],
      ['Qui a ete avale par un grand poisson ?', ['Jonas', 'Elisee', 'Etienne', 'Barnabas'], 'Jonas', 'Le livre de Jonas rapporte cet episode pendant sa fuite.', 'Jonas 1-2'],
      ['Quel est le premier livre de la Bible ?', ['Genese', 'Exode', 'Matthieu', 'Psaumes'], 'Genese', 'La Genese ouvre le recit biblique avec la creation.', 'Genese 1'],
      ['Jesus est ne a Bethleem.', ['Vrai', 'Faux'], 'Vrai', 'Les evangiles situent la naissance de Jesus a Bethleem.', 'Matthieu 2:1; Luc 2:4-7'],
      ['Qui a interprete des songes en Egypte avant de devenir responsable du pays ?', ['Joseph', 'Gedeon', 'Esau', 'Nathanael'], 'Joseph', 'Joseph interprete les songes de Pharaon et recoit une responsabilite en Egypte.', 'Genese 41']
    ],
    intermediaire: [
      ['Quel livre raconte principalement la sortie d Egypte ?', ['Exode', 'Juges', 'Ruth', 'Esther'], 'Exode', 'L Exode raconte la liberation d Israel et le depart d Egypte.', 'Exode 1-15'],
      ['Quel roi a demande la sagesse a Dieu ?', ['Salomon', 'Saul', 'Achab', 'Ezias'], 'Salomon', 'Salomon demande un coeur intelligent pour gouverner.', '1 Rois 3'],
      ['Dans quel livre trouve-t-on la reconstruction des murailles de Jerusalem ?', ['Nehemie', 'Josue', 'Job', 'Osee'], 'Nehemie', 'Nehemie conduit la reconstruction des murailles de Jerusalem.', 'Nehemie 1-6'],
      ['Quel evangile insiste sur les voyages missionnaires apres la resurrection dans son second volume, les Actes ?', ['Luc', 'Marc', 'Matthieu', 'Jean'], 'Luc', 'Luc est associe a l evangile de Luc et au livre des Actes.', 'Luc 1:1-4; Actes 1:1'],
      ['La Pentecote d Actes 2 a lieu apres l ascension de Jesus.', ['Vrai', 'Faux'], 'Vrai', 'Actes situe la Pentecote apres l ascension et l attente des disciples.', 'Actes 1-2'],
      ['Quel livre raconte l histoire de Ruth et de Booz ?', ['Ruth', 'Esther', 'Juges', 'Cantique'], 'Ruth', 'Le livre de Ruth raconte cette histoire dans le cadre familial de Naomi.', 'Ruth 1-4'],
      ['Quel prophete confronte les prophetes de Baal au mont Carmel ?', ['Elie', 'Jeremie', 'Habacuc', 'Aggee'], 'Elie', 'Elie affronte les prophetes de Baal dans le recit du Carmel.', '1 Rois 18'],
      ['Dans Actes, quel apotre preche a la Pentecote ?', ['Pierre', 'Thomas', 'Jacques fils d Alphee', 'Nicolas'], 'Pierre', 'Pierre explique aux foules le sens de ce qui arrive a la Pentecote.', 'Actes 2'],
      ['Le livre d Esther mentionne directement le nom de Dieu dans chaque chapitre.', ['Vrai', 'Faux'], 'Faux', 'Esther est connu pour ne pas mentionner explicitement le nom de Dieu.', 'Esther'],
      ['Quel livre contient le recit de la vocation d Esaie au temple ?', ['Esaie', 'Ezechiel', 'Amos', 'Malachie'], 'Esaie', 'Esaie 6 rapporte la vision et l appel du prophete.', 'Esaie 6']
    ],
    avance: [
      ['Quel theme relie l agneau pascal de l Exode et la presentation de Jesus dans le Nouveau Testament ?', ['La delivrance par le sacrifice', 'La conquete militaire', 'La royaute de Salomon', 'La construction du temple'], 'La delivrance par le sacrifice', 'Le Nouveau Testament emploie l image de l agneau pour parler de l oeuvre de Christ.', 'Exode 12; Jean 1:29'],
      ['Dans 1 Samuel, quel contraste structure souvent la comparaison entre Saul et David ?', ['Apparence exterieure et coeur', 'Richesse et pauvrete', 'Age et genealogie', 'Langue et territoire'], 'Apparence exterieure et coeur', 'Le recit souligne que Dieu regarde au coeur et non seulement a l apparence.', '1 Samuel 16:7'],
      ['Quel detail rend le retour d exil plus complexe qu une simple victoire politique ?', ['La restauration spirituelle reste incomplete', 'Babylone disparait immediatement', 'Tous les peuples rejoignent Juda', 'Le temple n est jamais reconstruit'], 'La restauration spirituelle reste incomplete', 'Esdras et Nehemie montrent une restauration reelle mais accompagnee de tensions spirituelles.', 'Esdras 9-10; Nehemie 13'],
      ['Dans les evangiles, les citations d Esaie servent souvent a montrer quoi ?', ['L accomplissement et le sens de la mission de Jesus', 'La fin de toute lecture prophetique', 'La superiorite de Rome', 'La genealogie de Moise'], 'L accomplissement et le sens de la mission de Jesus', 'Les evangiles utilisent Esaie pour interpreter l identite et la mission de Jesus.', 'Esaie 40; Marc 1:2-3'],
      ['Les paraboles doivent etre lues en tenant compte du contexte narratif ou Jesus les prononce.', ['Vrai', 'Faux'], 'Vrai', 'Le contexte aide a identifier l enjeu principal d une parabole.', 'Luc 15'],
      ['Quel lien unit Melchisedek et l argumentation de l epitre aux Hebreux ?', ['Un sacerdoce distinct de celui de Levi', 'La construction de l arche', 'La prise de Jericho', 'La chute de Samarie'], 'Un sacerdoce distinct de celui de Levi', 'Hebreux utilise Melchisedek pour expliquer le sacerdoce du Christ.', 'Genese 14; Hebreux 7'],
      ['Pourquoi le livre des Juges repete-t-il des cycles de chute et de delivrance ?', ['Pour montrer l instabilite spirituelle d Israel', 'Pour lister les rois de Juda', 'Pour dater les empires grecs', 'Pour expliquer la genealogie de Paul'], 'Pour montrer l instabilite spirituelle d Israel', 'Les cycles soulignent l infidelite, l oppression, le cri et la delivrance.', 'Juges 2'],
      ['Quel passage associe explicitement une nouvelle alliance a une transformation interieure ?', ['Jeremie 31', 'Josue 6', '1 Samuel 8', 'Jonas 4'], 'Jeremie 31', 'Jeremie annonce une alliance ecrite dans le coeur.', 'Jeremie 31:31-34'],
      ['Dans Marc, le secret messianique invite a suivre la progression narrative de l identite de Jesus.', ['Vrai', 'Faux'], 'Vrai', 'Marc developpe progressivement la revelation de l identite et de la mission de Jesus.', 'Marc 8-10'],
      ['Quel contraste majeur apparait entre Babel et la Pentecote ?', ['Confusion dispersee et annonce comprise par plusieurs peuples', 'Royaute de David et exil perse', 'Sabbat et jubile', 'Temple et synagogue'], 'Confusion dispersee et annonce comprise par plusieurs peuples', 'Babel disperse par confusion, tandis qu Actes 2 montre une annonce comprise par des peuples divers.', 'Genese 11; Actes 2']
    ],
    expert: [
      ['Dans Daniel 7, quel element montre que la vision depasse une simple liste de royaumes ?', ['La scene du tribunal celeste', 'La mention d une ville portuaire', 'La genealogie d Abraham', 'Le recensement de David'], 'La scene du tribunal celeste', 'La vision articule symboles politiques et jugement divin dans une scene celeste.', 'Daniel 7:9-14'],
      ['Quel lien thematique unit l exil, le reste fidele et l esperance prophetique ?', ['Le jugement suivi d une restauration promise', 'La disparition de l alliance', 'La fin du culte dans tout le Proche-Orient', 'La victoire definitive de l Assyrie'], 'Le jugement suivi d une restauration promise', 'Les prophetes articulent souvent jugement, reste et restauration.', 'Esaie 10; Jeremie 31'],
      ['Pourquoi la geographie de Samarie est-elle importante dans Jean 4 ?', ['Elle met en jeu une frontiere religieuse et sociale', 'Elle prouve que Jesus evite tout dialogue', 'Elle situe le temple de Salomon', 'Elle decrit la route de l exode'], 'Elle met en jeu une frontiere religieuse et sociale', 'Le dialogue avec la Samaritaine prend sens dans les tensions entre Juifs et Samaritains.', 'Jean 4'],
      ['Dans Zacharie, les visions symboliques demandent souvent de distinguer quoi ?', ['Image visionnaire et message prophetique', 'Proverbe et genealogie', 'Loi civile et recit de creation', 'Psaume royal et liste tribale'], 'Image visionnaire et message prophetique', 'Les visions utilisent des images qui servent un message de restauration et de jugement.', 'Zacharie 1-6'],
      ['Une question expert peut demander de comparer un symbole entre plusieurs passages bibliques.', ['Vrai', 'Faux'], 'Vrai', 'Le niveau expert mobilise les liens entre textes, symboles et contexte.', 'Daniel 7; Apocalypse 13'],
      ['Dans Apocalypse, pourquoi les images de betes demandent-elles souvent une lecture intertextuelle ?', ['Elles reprennent des motifs de Daniel', 'Elles remplacent les evangiles', 'Elles datent la creation', 'Elles nomment tous les apotres'], 'Elles reprennent des motifs de Daniel', 'Plusieurs images de l Apocalypse dialoguent avec Daniel et d autres textes prophetique.', 'Daniel 7; Apocalypse 13'],
      ['Quel enjeu theologique traverse le recit de 1 Rois 12 ?', ['Division du royaume et culte concurrent', 'Naissance de Moise', 'Retour de Paul a Tarse', 'Institution de la Paque en Egypte'], 'Division du royaume et culte concurrent', 'La division politique s accompagne d un enjeu cultuel autour des sanctuaires du Nord.', '1 Rois 12'],
      ['Pourquoi la mention de Cyrus est-elle importante pour lire Esdras 1 ?', ['Elle situe le retour dans la politique perse', 'Elle annonce la domination romaine', 'Elle identifie un juge d Israel', 'Elle nomme un disciple de Jesus'], 'Elle situe le retour dans la politique perse', 'Le decret de Cyrus ouvre le cadre historique du retour d exil.', 'Esdras 1'],
      ['Comparer Romains 4 et Genese 15 aide a comprendre l argument de Paul sur la foi.', ['Vrai', 'Faux'], 'Vrai', 'Paul s appuie sur Abraham pour developper son argument sur la justice par la foi.', 'Genese 15:6; Romains 4'],
      ['Quel symbole d Ezechiel 37 articule restauration nationale et action de l Esprit ?', ['Les ossements desseches', 'La manne', 'Le buisson ardent', 'La barque de Jonas'], 'Les ossements desseches', 'La vision utilise l image des ossements revivifies pour annoncer restauration et souffle divin.', 'Ezechiel 37']
    ],
    scholar: [
      ['Quel empire constitue l arriere-plan majeur de la chute du royaume du Nord en 722 av. J.-C. ?', ['Assyrie', 'Perse', 'Rome', 'Egypte ptolemaique'], 'Assyrie', 'La chute de Samarie est rattachee historiquement a l expansion assyrienne.', '2 Rois 17'],
      ['Dans le contexte perse, quel enjeu historique eclaire les retours d exil ?', ['Les politiques imperiales de rapatriement et de restauration locale', 'La citoyennete romaine', 'La domination seleucide directe', 'Les croisades medievales'], 'Les politiques imperiales de rapatriement et de restauration locale', 'Les retours d exil s inscrivent dans le cadre de l empire perse et de ses decrets.', 'Esdras 1'],
      ['Quel arriere-plan culturel aide a comprendre l importance des repas dans Luc ?', ['Les codes d honneur, d hospitalite et de reciprocite', 'Les jeux du cirque', 'La monnaie byzantine', 'Les guildes medievales'], 'Les codes d honneur, d hospitalite et de reciprocite', 'Les scenes de repas dans Luc gagnent en relief avec les pratiques sociales mediterraneennes antiques.', 'Luc 14'],
      ['Pourquoi les Diadoques sont-ils utiles pour situer certaines lectures historiques de Daniel ?', ['Ils expliquent la division de l empire d Alexandre', 'Ils sont les douze fils de Jacob', 'Ils fondent le royaume de Juda', 'Ils ecrivent les Psaumes'], 'Ils expliquent la division de l empire d Alexandre', 'Les Bibles d etude relient souvent Daniel 8 et 11 au monde hellenistique apres Alexandre.', 'Daniel 8; Daniel 11'],
      ['En niveau Scholar, une note historique doit etre distinguee du texte biblique direct.', ['Vrai', 'Faux'], 'Vrai', 'Le contexte historique peut eclairer le texte sans etre presente comme une citation biblique directe.', 'Principe d etude biblique'],
      ['Quel contexte imperial eclaire la tension entre royaume de Dieu et titres politiques dans le Nouveau Testament ?', ['Le monde romain', 'Le royaume hittite', 'La monarchie carolingienne', 'La Perse sassanide'], 'Le monde romain', 'Le langage royal du Nouveau Testament se deploie dans un monde marque par l autorite romaine.', 'Luc 2; Jean 19'],
      ['Pourquoi Qumran est-il parfois cite dans les Bibles d etude ?', ['Pour situer certains courants juifs du Second Temple', 'Pour remplacer le texte biblique', 'Pour dater Abraham', 'Pour expliquer la chute de Ninive'], 'Pour situer certains courants juifs du Second Temple', 'Qumran aide a comprendre un arriere-plan juif ancien sans devenir la source normative du texte biblique.', 'Contexte du Second Temple'],
      ['Quel empire domine Juda au moment ou Nehemie obtient l autorisation de reconstruire ?', ['Perse', 'Assyrie', 'Rome', 'Babylone ancienne'], 'Perse', 'Nehemie sert a la cour perse avant son depart pour Jerusalem.', 'Nehemie 1-2'],
      ['Dans l etude de Daniel 11, distinguer texte, symbole et rapprochement historique evite de presenter une interpretation comme une certitude absolue.', ['Vrai', 'Faux'], 'Vrai', 'Le niveau Scholar doit separer le texte biblique des identifications historiques proposees par les commentateurs.', 'Daniel 11'],
      ['Quel arriere-plan aide a comprendre les collectes de Paul pour Jerusalem ?', ['Les solidarites entre eglises et la situation economique de saints de Jerusalem', 'Le culte imperial obligatoire dans le temple', 'Le retour de l exil sous Cyrus', 'La construction du tabernacle'], 'Les solidarites entre eglises et la situation economique de saints de Jerusalem', 'Paul presente la collecte comme un service concret entre croyants issus de differents milieux.', '2 Corinthiens 8-9; Romains 15:25-27']
    ]
  };
  return pools[normalizedLevel].map((item, index) => sanitizeQuestion({
    id: `fallback-${normalizedLevel}-${index + 1}`,
    question: item[0],
    type: item[1].length === 2 ? 'vrai_faux' : 'qcm',
    options: item[1],
    correctAnswer: item[2],
    explanation: item[3],
    reference: item[4],
    category: category && category !== 'random' ? category : 'contexte_historique',
    level: normalizedLevel,
    isActive: true
  }));
}

function groupedLeaderboard() {
  const limits = {
    beginner: 1,
    intermediate: 2,
    advanced: 3,
    expert: 4,
    scholar: 5
  };
  const grouped = Object.fromEntries(Object.keys(limits).map((key) => [key, []]));
  for (const row of readJson('leaderboard.json').map(normalizeLeaderboardRow)) {
    const key = leaderboardLevelKey(row.level);
    if (grouped[key]) grouped[key].push(row);
  }
  for (const [key, rows] of Object.entries(grouped)) {
    grouped[key] = rows
      .sort(compareLeaderboardRows)
      .slice(0, limits[key])
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }
  return grouped;
}

function normalizeLeaderboardRow(row) {
  const pointsObtenus = Number(row.pointsObtenus ?? row.score ?? 0);
  const durationSeconds = Math.max(1, Number(row.durationSeconds ?? row.duration ?? 1));
  const pointsMaxPossibles = Math.max(1, Number(row.pointsMaxPossibles ?? inferMaxPoints(row)));
  const pourcentagePoints = Number.isFinite(Number(row.pourcentagePoints))
    ? Number(row.pourcentagePoints)
    : (pointsObtenus / pointsMaxPossibles) * 100;
  return {
    ...row,
    pointsObtenus,
    score: pointsObtenus,
    pointsMaxPossibles,
    pourcentagePoints,
    scorePerformance: Number.isFinite(Number(row.scorePerformance)) ? Number(row.scorePerformance) : pointsObtenus / durationSeconds,
    durationSeconds,
    percent: Number.isFinite(Number(row.percent)) ? Number(row.percent) : Math.round(pourcentagePoints)
  };
}

function inferMaxPoints(row) {
  if (row.totalQuestions) return Number(row.totalQuestions) * 15;
  return Math.max(Number(row.score || 0), 1);
}

function compareLeaderboardRows(a, b) {
  return b.scorePerformance - a.scorePerformance
    || b.pourcentagePoints - a.pourcentagePoints
    || a.durationSeconds - b.durationSeconds
    || new Date(b.createdAt) - new Date(a.createdAt);
}

function leaderboardLevelKey(level) {
  const normalized = normalize(level || '');
  if (['debutant', 'debutants', 'beginner'].includes(normalized)) return 'beginner';
  if (['intermediaire', 'intermediate'].includes(normalized)) return 'intermediate';
  if (['avance', 'advanced'].includes(normalized)) return 'advanced';
  if (normalized === 'expert') return 'expert';
  if (normalized === 'scholar') return 'scholar';
  return 'beginner';
}

function broadCategoryMatch(category, questionCategory) {
  if (category === 'ancien_testament') {
    return ['pentateuque', 'livres_historiques', 'livres_poetiques', 'livres_prophetiques', 'vie_des_prophetes', 'contexte_historique'].includes(questionCategory);
  }
  if (category === 'nouveau_testament') {
    return ['evangiles', 'actes', 'epitres', 'apocalypse'].includes(questionCategory);
  }
  return false;
}

function withoutAnswer(question) {
  const { correctAnswer, ...safe } = shuffleQuestionOptions(question);
  return safe;
}

function scoreGame(body) {
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const gameSessionId = sanitizeString(body.gameSessionId || '').slice(0, 100);
  const sessionQuestions = gameSessionId
    ? readJson('gameQuestions.json').filter((question) => question.gameSessionId === gameSessionId || question.roundId === gameSessionId)
    : [];
  const questions = sessionQuestions.length ? sessionQuestions : readJson('questions.json');
  const seenQuestionIds = new Set();
  let score = 0;
  let correctAnswers = 0;
  const review = answers.filter((answer) => {
    if (!answer?.questionId || seenQuestionIds.has(answer.questionId)) return false;
    seenQuestionIds.add(answer.questionId);
    return true;
  }).map((answer) => {
    const question = questions.find((q) => q.id === answer.questionId);
    if (!question) return null;
    const isCorrect = normalize(answer.answer) === normalize(question.correctAnswer);
    const timeLeft = Number(answer.timeLeft || 0);
    const timeLimit = Number(answer.timeLimit || body.timeLimit || 30);
    const bonus = isCorrect ? clamp(Math.ceil((timeLeft / Math.max(timeLimit, 1)) * 5), 0, 5) : 0;
    if (isCorrect) {
      correctAnswers += 1;
      score += 10 + bonus;
    }
    return {
      questionId: question.id,
      question: question.question,
      answer: sanitizeString(answer.answer),
      correctAnswer: question.correctAnswer,
      isCorrect,
      points: isCorrect ? 10 + bonus : 0,
      explanation: question.explanation,
      historicalNote: question.historicalNote,
      reference: question.reference
    };
  }).filter(Boolean);
  const totalQuestions = review.length;
  const percent = totalQuestions ? Math.round((correctAnswers / totalQuestions) * 100) : 0;
  const durationSeconds = Math.max(1, Number(body.duration || 0));
  const pointsMaxPossibles = totalQuestions * 15;
  const pourcentagePoints = pointsMaxPossibles ? (score / pointsMaxPossibles) * 100 : 0;
  const scorePerformance = score / durationSeconds;
  const levelEstimate = percent >= 90 ? 'Expert' : percent >= 75 ? 'Avance' : percent >= 55 ? 'Intermediaire' : 'Debutant';
  const createdAt = new Date().toISOString();
  const playerName = sanitizeString(body.playerName || 'Anonyme').slice(0, 40) || 'Anonyme';
  const level = sanitizeString(body.level || 'debutant');
  const session = {
    id: `gs-${crypto.randomUUID()}`,
    gameSessionId,
    playerName,
    category: sanitizeString(body.category || 'random'),
    level,
    score,
    pointsObtenus: score,
    pointsMaxPossibles,
    pourcentagePoints,
    scorePerformance,
    totalQuestions,
    correctAnswers,
    duration: durationSeconds,
    durationSeconds,
    createdAt
  };
  return {
    session,
    leaderboard: {
      id: `lb-${crypto.randomUUID()}`,
      gameSessionId,
      playerName,
      score,
      pointsObtenus: score,
      pointsMaxPossibles,
      pourcentagePoints,
      scorePerformance,
      durationSeconds,
      category: session.category,
      level,
      percent,
      createdAt
    },
    review,
    percent,
    levelEstimate,
    encouragement: encouragement(percent),
    recommendations: recommendations(percent, session.category)
  };
}

function checkSingleAnswer(body) {
  const gameSessionId = sanitizeString(body.gameSessionId || '').slice(0, 100);
  const gameQuestion = gameSessionId
    ? readJson('gameQuestions.json').find((q) => (q.gameSessionId === gameSessionId || q.roundId === gameSessionId) && q.id === body.questionId)
    : null;
  const question = gameQuestion || readJson('questions.json').find((q) => q.id === body.questionId);
  if (!question) return null;
  const isCorrect = normalize(body.answer) === normalize(question.correctAnswer);
  const timeLeft = Number(body.timeLeft || 0);
  const timeLimit = Number(body.timeLimit || 30);
  const bonus = isCorrect ? clamp(Math.ceil((timeLeft / Math.max(timeLimit, 1)) * 5), 0, 5) : 0;
  return {
    questionId: question.id,
    question: question.question,
    answer: sanitizeString(body.answer),
    correctAnswer: question.correctAnswer,
    isCorrect,
    points: isCorrect ? 10 + bonus : 0,
    explanation: question.explanation,
    historicalNote: question.historicalNote,
    reference: question.reference
  };
}

async function generateQuestions(input) {
  const category = validId(input.category, categories, 'random');
  const level = validId(normalizeLevelId(input.level), levels, 'debutant');
  const count = clamp(Number(input.count || 10), 1, 20);
  const requestedTypes = Array.isArray(input.questionTypes) && input.questionTypes.length
    ? input.questionTypes.filter((type) => questionTypes.includes(type))
    : ['qcm', 'vrai_faux', 'personnage'];

  if (!azureConfigured()) {
    const fallback = selectQuestions(category, level, count, { avoidQuestions: input.recentQuestions || [] }).map((q) => ({ ...q, source: 'fallback_local' }));
    recordGeneratedQuestions(fallback, 'local');
    return fallback;
  }

  const prompt = {
    category,
    level,
    difficultyGuidance: difficultyGuidance(level),
    difficultySeparation: difficultySeparationRules(level),
    count,
    questionTypes: requestedTypes,
    theme: sanitizeString(input.theme || '').slice(0, 200),
    sourceText: sanitizeString(input.sourceText || '').slice(0, 6000),
    instruction: sanitizeString(input.instruction || '').slice(0, 800),
    textOnly: Boolean(input.textOnly),
    antiRepetition: {
      instruction: aiAntiRepetitionInstruction,
      recentlyGeneratedQuestions: recentGeneratedQuestionTexts(category, level, 100),
      rules: [
        'ne pas reutiliser une question deja generee',
        'ne pas reformuler legerement une ancienne question',
        'ne pas generer de questions identiques ou quasi identiques aux niveaux precedents',
        'adapter fortement la profondeur au niveau demande',
        'varier personnages, livres, empires, lieux et themes',
        'eviter meme reponse avec meme structure'
      ],
      rotationTopics
    },
    outputShape: {
      questions: [{
        id: 'string',
        question: 'string',
        type: 'qcm',
        options: ['string', 'string', 'string', 'string'],
        correctAnswer: 'string',
        explanation: 'string',
        reference: 'string',
        historicalNote: 'string optionnel, separe du texte biblique direct',
        difficulty: level,
        category
      }]
    }
  };

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '');
  const deployment = encodeURIComponent(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion = encodeURIComponent(process.env.AZURE_OPENAI_API_VERSION);
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.AZURE_OPENAI_API_KEY
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: [
            'Tu es un generateur de quiz biblique pedagogique. Genere uniquement des questions bibliques fiables, claires, non ambigues, avec une bonne reponse exacte, des distracteurs plausibles, une explication courte et une reference biblique si possible. Ne genere pas de doctrine controversee comme verite absolue. Pour les questions historiques, distingue clairement le texte biblique du contexte historique issu des Bibles d etude. Si textOnly est vrai, n utilise que les informations presentes dans sourceText. Reponds uniquement en JSON valide.',
            aiAntiRepetitionInstruction,
            isScholarLevel(level) ? scholarInstruction : ''
          ].filter(Boolean).join(' ')
        },
        { role: 'user', content: JSON.stringify(prompt) }
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const fallback = selectQuestions(category, level, count).map((q) => ({ ...q, source: 'fallback_local' }));
    recordGeneratedQuestions(fallback, 'local');
    return fallback;
  }

  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const generated = Array.isArray(parsed.questions) ? parsed.questions : [];
  const valid = generated.map((q) => sanitizeQuestion({
    ...q,
    id: q.id || `q-${crypto.randomUUID()}`,
    level: q.level || q.difficulty || level,
    category: q.category || category,
    isActive: true,
    createdAt: new Date().toISOString()
  })).filter((question) => validateQuestion(question) && !isDuplicateQuestion(question, input.recentQuestions || []));
  if (valid.length) {
    const selected = valid.slice(0, count);
    recordGeneratedQuestions(selected, 'AI');
    return selected;
  }
  const fallback = selectQuestions(category, level, count, { avoidQuestions: input.recentQuestions || [] }).map((q) => ({ ...q, source: 'fallback_local' }));
  recordGeneratedQuestions(fallback, 'local');
  return fallback;
}

async function generateOperatorDrafts(input, method) {
  const count = clamp(Number(input.count || 5), 1, 20);
  const generated = await generateQuestions({
    category: input.category || 'random',
    level: input.difficulty || input.level || 'intermediaire',
    count,
    questionTypes: Array.isArray(input.questionTypes) ? input.questionTypes : [input.type || 'qcm'],
    theme: input.theme,
    sourceText: method === 'generate-from-text' ? input.rawText || input.text : '',
    instruction: input.instruction || input.instructions || '',
    textOnly: input.textOnly
  });
  return generated.map((question) => ({
    ...question,
    status: 'draft',
    isActive: false,
    aiValidationStatus: question.aiValidationStatus || 'draft_generated',
    aiValidationNotes: method === 'generate-from-text' && input.textOnly ? 'Genere en mode base uniquement sur le texte fourni' : 'Brouillon genere par IA'
  }));
}

function azureConfigured() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_DEPLOYMENT &&
    process.env.AZURE_OPENAI_API_VERSION
  );
}

function sanitizeQuestion(body) {
  const options = Array.isArray(body.options) ? body.options.map((v) => sanitizeString(v).slice(0, 180)).filter(Boolean) : [];
  return {
    id: sanitizeString(body.id || '').slice(0, 80),
    question: sanitizeString(body.question || '').slice(0, 500),
    type: questionTypes.includes(body.type) ? body.type : 'qcm',
    options: options.length ? options : ['Vrai', 'Faux'],
    correctAnswer: sanitizeString(body.correctAnswer || '').slice(0, 180),
    explanation: sanitizeString(body.explanation || '').slice(0, 700),
    historicalNote: sanitizeString(body.historicalNote || body.historyNote || '').slice(0, 500),
    reference: sanitizeString(body.reference || '').slice(0, 120),
    category: sanitizeString(body.category || 'random').slice(0, 80),
    level: sanitizeString(body.level || body.difficulty || 'debutant').slice(0, 80),
    isActive: body.isActive !== false,
    createdAt: body.createdAt || new Date().toISOString()
  };
}

function validateQuestion(question) {
  if (!question.question || !question.correctAnswer || !question.explanation) return false;
  if (!Array.isArray(question.options) || question.options.length < 2) return false;
  if (!question.options.some((option) => normalize(option) === normalize(question.correctAnswer))) return false;
  if (question.type === 'qcm' && question.options.length !== 4) return false;
  return true;
}

function sanitizeChallenge(body) {
  return {
    id: sanitizeString(body.id || '').slice(0, 80),
    title: sanitizeString(body.title || '').slice(0, 160),
    description: sanitizeString(body.description || '').slice(0, 600),
    category: sanitizeString(body.category || 'random').slice(0, 80),
    level: sanitizeString(body.level || 'debutant').slice(0, 80),
    days: clamp(Number(body.days || 7), 1, 30),
    progression: clamp(Number(body.progression || 0), 0, 100),
    summary: sanitizeString(body.summary || '').slice(0, 500),
    operatorIds: parseList(body.operatorIds),
    isActive: body.isActive !== false,
    createdAt: body.createdAt || new Date().toISOString()
  };
}

function sanitizeQuestionBank(body, user) {
  return {
    title: sanitizeString(body.title || 'Banque de questions').slice(0, 160),
    description: sanitizeString(body.description || '').slice(0, 600),
    category: sanitizeString(body.category || 'random').slice(0, 80),
    difficulty: sanitizeString(body.difficulty || body.level || 'intermediaire').slice(0, 80),
    language: sanitizeString(body.language || 'fr').slice(0, 20),
    createdBy: sanitizeString(body.createdBy || user?.id || '').slice(0, 100),
    operatorIds: parseList(body.operatorIds),
    isPublic: body.isPublic !== false,
    isActive: body.isActive !== false
  };
}

function sanitizeBankQuestion(body, bankId) {
  const question = sanitizeQuestion(body);
  return {
    id: question.id,
    bankId,
    question: question.question,
    type: question.type,
    options: question.options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    historicalNote: question.historicalNote,
    reference: question.reference,
    category: question.category,
    difficulty: question.level,
    tags: Array.isArray(body.tags) ? body.tags.map((tag) => sanitizeString(tag).slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    status: ['draft', 'active', 'inactive', 'rejected'].includes(body.status) ? body.status : (question.isActive ? 'active' : 'inactive'),
    isActive: body.status ? body.status === 'active' : question.isActive
  };
}

function sanitizeChallengeQuestion(body, challengeId) {
  const question = sanitizeBankQuestion(body, '');
  delete question.bankId;
  return { ...question, challengeId };
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeString(item).slice(0, 100)).filter(Boolean);
  return sanitizeString(value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 50);
}

function registerUser(body) {
  const users = readJson('users.json');
  const email = sanitizeString(body.email || '').toLowerCase();
  const name = sanitizeString(body.name || body.playerName || 'Utilisateur').slice(0, 80);
  const password = String(body.password || '');
  if (!email || !email.includes('@')) return { error: 'Email invalide', status: 400 };
  if (password.length < 6) return { error: 'Mot de passe trop court', status: 400 };
  if (users.some((user) => user.email === email)) return { error: 'Utilisateur deja existant', status: 409 };
  const requestedRole = sanitizeString(body.role || '');
  const role = users.length === 0 ? 'admin' : (['operator', 'host', 'player'].includes(requestedRole) ? requestedRole : 'player');
  const user = {
    id: `user-${crypto.randomUUID()}`,
    name,
    email,
    passwordHash: hashPassword(password),
    role,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  users.push(user);
  writeJson('users.json', users);
  return { user };
}

function loginUser(body) {
  const rawLogin = sanitizeString(body.email || body.username || '');
  const login = rawLogin.toLowerCase();
  const user = readJson('users.json').find((item) => item.email === login || normalize(item.name) === normalize(login));
  if (user) {
    if (!user.isActive || user.passwordHash !== hashPassword(String(body.password || ''))) return { error: 'Identifiants invalides', status: 401 };
    return { user };
  }
  if (envAdminCredentialsMatch(rawLogin, body.password)) return { user: envAdminUser() };
  return { error: 'Identifiants invalides', status: 401 };
}

function updateUserAdmin(userId, field, body) {
  const users = readJson('users.json');
  const user = users.find((item) => item.id === userId);
  if (!user) return { error: 'Utilisateur introuvable', status: 404 };
  if (field === 'role') {
    const role = sanitizeString(body.role || '');
    if (!['admin', 'operator', 'host', 'player'].includes(role)) return { error: 'Role invalide', status: 400 };
    user.role = role;
  }
  if (field === 'status') user.isActive = body.isActive !== false;
  user.updatedAt = new Date().toISOString();
  writeJson('users.json', users);
  return { user };
}

function createUserByAdmin(body) {
  const users = readJson('users.json');
  const email = sanitizeString(body.email || body.username || '').toLowerCase();
  const password = String(body.password || '');
  const role = sanitizeString(body.role || 'player');
  if (!email) return { error: 'Email ou username requis', status: 400 };
  if (password.length < 6) return { error: 'Mot de passe temporaire trop court', status: 400 };
  if (!['admin', 'operator', 'host', 'player'].includes(role)) return { error: 'Role invalide', status: 400 };
  if (users.some((user) => user.email === email)) return { error: 'Utilisateur deja existant', status: 409 };
  const user = {
    id: `user-${crypto.randomUUID()}`,
    name: sanitizeString(body.name || email).slice(0, 80),
    email,
    passwordHash: hashPassword(password),
    role,
    isActive: body.isActive !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  users.push(user);
  writeJson('users.json', users);
  return { user };
}

function patchUserByAdmin(userId, action, body) {
  const users = readJson('users.json');
  const user = users.find((item) => item.id === userId);
  if (!user) return { error: 'Utilisateur introuvable', status: 404 };
  if (action === 'password') {
    const password = String(body.password || '');
    if (password.length < 6) return { error: 'Mot de passe trop court', status: 400 };
    user.passwordHash = hashPassword(password);
  } else if (action === 'disable') {
    user.isActive = false;
  } else {
    if (body.name !== undefined) user.name = sanitizeString(body.name).slice(0, 80);
    if (body.email !== undefined || body.username !== undefined) user.email = sanitizeString(body.email || body.username).toLowerCase();
    if (body.role !== undefined) {
      const role = sanitizeString(body.role);
      if (!['admin', 'operator', 'host', 'player'].includes(role)) return { error: 'Role invalide', status: 400 };
      user.role = role;
    }
    if (body.isActive !== undefined) user.isActive = body.isActive !== false;
  }
  user.updatedAt = new Date().toISOString();
  writeJson('users.json', users);
  return { user };
}

function sendUserSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  userSessions.set(token, { userId: user.id, source: user.source || 'user', createdAt: Date.now() });
  res.setHeader('Set-Cookie', `qb_user_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function currentUser(req) {
  const token = getCookie(req, 'qb_user_session');
  const session = token && userSessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
    userSessions.delete(token);
    return null;
  }
  if (session.source === 'env' || session.userId === 'env-admin') return envAdminUser();
  const user = readJson('users.json').find((item) => item.id === session.userId && item.isActive !== false);
  return user || null;
}

function requireRole(req, roles) {
  const user = currentUser(req);
  if (user && roles.includes(user.role)) return user;
  if (roles.includes('admin') && isAdmin(req)) return { id: 'legacy-admin', role: 'admin', name: 'Admin' };
  return null;
}

function canManageBank(req, bank) {
  const user = currentUser(req);
  if (isAdmin(req) || user?.role === 'admin') return true;
  return user?.role === 'operator' && (bank.createdBy === user.id || (bank.operatorIds || []).includes(user.id));
}

function canOperateStructure(user, item) {
  if (user?.role === 'admin') return true;
  return user?.role === 'operator' && (item.createdBy === user.id || (item.operatorIds || []).includes(user.id));
}

function publicUser(user) {
  if (!user) return null;
  if (user.source === 'env') return envAdminUser();
  const { passwordHash, ...safe } = user;
  return safe;
}

function envAdminUser() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  return {
    id: 'env-admin',
    username,
    name: 'Admin systeme (.env)',
    role: 'admin',
    source: 'env'
  };
}

function envAdminCredentialsMatch(username, password) {
  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || 'change-me';
  return safeEqual(String(username || ''), expectedUsername) && safeEqual(String(password || ''), expectedPassword);
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(`quiz-bible:${password}`).digest('hex');
}

function sanitizeString(value) {
  return String(value ?? '').replace(/[<>]/g, '').trim();
}

function normalize(value) {
  return sanitizeString(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.split('=').slice(1).join('=');
}

function isAdmin(req) {
  const token = getCookie(req, 'qb_session');
  const session = token && sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > 8 * 60 * 60 * 1000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function rateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (generationHits.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  hits.push(now);
  generationHits.set(ip, hits);
  return hits.length <= RATE_MAX;
}

function validId(value, list, fallback) {
  return list.some((item) => item.id === value) ? value : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function shuffleQuestionOptions(question) {
  return {
    ...question,
    options: shuffle(question.options || [])
  };
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function encouragement(percent) {
  if (percent >= 90) return 'Excellent parcours. Continue avec les questions de contexte et de memorisation.';
  if (percent >= 75) return 'Tres bon resultat. Quelques details bibliques peuvent encore renforcer ta maitrise.';
  if (percent >= 55) return 'Bonne progression. Revois les references indiquees pour consolider les bases.';
  return 'Continue avec les niveaux debutants et les challenges de 7 jours pour poser des reperes solides.';
}

function recommendations(percent, category) {
  const base = [
    'Relire les references des questions manquees.',
    'Refaire une partie courte avec 5 questions pour memoriser.'
  ];
  if (percent < 70) base.push('Choisir un challenge 7 jours lie a la categorie jouee.');
  if (category === 'contexte_historique') base.push('Distinguer le texte biblique des notes historiques de Bible d etude.');
  return base;
}
