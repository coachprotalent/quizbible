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
  ['expert', 'Expert']
].map(([id, label]) => ({ id, label }));

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
    const leaderboard = readJson('leaderboard.json')
      .sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50);
    sendJson(res, 200, { leaderboard });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start-game') {
    const body = await readBody(req);
    const count = clamp(Number(body.count || 10), 5, 20);
    const selected = selectQuestions(body.category, body.level, count);
    sendJson(res, 200, { questions: selected.map(withoutAnswer) });
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
    appendJson('sessions.json', result.session);
    appendJson('leaderboard.json', result.leaderboard);
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

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const body = await readBody(req);
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'change-me';
    if (safeEqual(String(body.username || ''), username) && safeEqual(String(body.password || ''), password)) {
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { createdAt: Date.now(), username });
      res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 401, { error: 'Identifiants invalides' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = getCookie(req, 'qb_session');
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'qb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'Connexion admin requise' });
      return;
    }
    await handleAdminApi(req, res, url);
    return;
  }

  sendJson(res, 404, { error: 'Route introuvable' });
}

async function handleAdminApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
    sendJson(res, 200, {
      questions: readJson('questions.json'),
      challenges: readJson('challenges.json'),
      sessions: readJson('sessions.json'),
      leaderboard: readJson('leaderboard.json'),
      categories,
      levels
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/questions') {
    const body = sanitizeQuestion(await readBody(req));
    const questions = readJson('questions.json');
    body.id = body.id || `q-${crypto.randomUUID()}`;
    body.createdAt = body.createdAt || new Date().toISOString();
    questions.push(body);
    writeJson('questions.json', questions);
    sendJson(res, 201, { question: body });
    return;
  }

  const questionMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)$/);
  if (questionMatch && req.method === 'PUT') {
    const id = decodeURIComponent(questionMatch[1]);
    const body = sanitizeQuestion(await readBody(req));
    const questions = readJson('questions.json');
    const index = questions.findIndex((q) => q.id === id);
    if (index === -1) return sendJson(res, 404, { error: 'Question introuvable' });
    questions[index] = { ...questions[index], ...body, id };
    writeJson('questions.json', questions);
    sendJson(res, 200, { question: questions[index] });
    return;
  }

  if (questionMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(questionMatch[1]);
    writeJson('questions.json', readJson('questions.json').filter((q) => q.id !== id));
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

  const challengeMatch = url.pathname.match(/^\/api\/admin\/challenges\/([^/]+)$/);
  if (challengeMatch && req.method === 'PUT') {
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

  if (req.method === 'POST' && url.pathname === '/api/admin/generate-questions') {
    const body = await readBody(req);
    const generated = await generateQuestions({ ...body, count: body.count || 20 });
    const questions = readJson('questions.json');
    const saved = generated.map((q) => sanitizeQuestion({ ...q, id: q.id || `q-${crypto.randomUUID()}`, isActive: true, createdAt: new Date().toISOString() }));
    writeJson('questions.json', questions.concat(saved));
    sendJson(res, 200, { questions: saved });
    return;
  }

  sendJson(res, 404, { error: 'Route admin introuvable' });
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
  const cleanPath = pathname === '/' || pathname === '/admin' ? '/index.html' : pathname;
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

function selectQuestions(category, level, count) {
  const questions = readJson('questions.json').filter((q) => q.isActive !== false);
  const filtered = questions.filter((q) => {
    const categoryOk = !category || category === 'random' || q.category === category || broadCategoryMatch(category, q.category);
    const levelOk = !level || q.level === level;
    return categoryOk && levelOk;
  });
  const pool = filtered.length >= count ? filtered : questions;
  return shuffle(pool).slice(0, count);
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
  const { correctAnswer, ...safe } = question;
  return safe;
}

function scoreGame(body) {
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const questions = readJson('questions.json');
  let score = 0;
  let correctAnswers = 0;
  const review = answers.map((answer) => {
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
      reference: question.reference
    };
  }).filter(Boolean);
  const totalQuestions = review.length;
  const percent = totalQuestions ? Math.round((correctAnswers / totalQuestions) * 100) : 0;
  const levelEstimate = percent >= 90 ? 'Expert' : percent >= 75 ? 'Avance' : percent >= 55 ? 'Intermediaire' : 'Debutant';
  const createdAt = new Date().toISOString();
  const playerName = sanitizeString(body.playerName || 'Anonyme').slice(0, 40) || 'Anonyme';
  const session = {
    id: `gs-${crypto.randomUUID()}`,
    playerName,
    category: sanitizeString(body.category || 'random'),
    level: sanitizeString(body.level || 'debutant'),
    score,
    totalQuestions,
    correctAnswers,
    duration: Number(body.duration || 0),
    createdAt
  };
  return {
    session,
    leaderboard: {
      id: `lb-${crypto.randomUUID()}`,
      playerName,
      score,
      category: session.category,
      level: session.level,
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
  const question = readJson('questions.json').find((q) => q.id === body.questionId);
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
    reference: question.reference
  };
}

async function generateQuestions(input) {
  const category = validId(input.category, categories, 'random');
  const level = validId(input.level, levels, 'debutant');
  const count = clamp(Number(input.count || 10), 1, 20);
  const requestedTypes = Array.isArray(input.questionTypes) && input.questionTypes.length
    ? input.questionTypes.filter((type) => questionTypes.includes(type))
    : ['qcm', 'vrai_faux', 'personnage'];

  if (!azureConfigured()) {
    return selectQuestions(category, level, count).map((q) => ({ ...q, source: 'fallback_local' }));
  }

  const prompt = {
    category,
    level,
    count,
    questionTypes: requestedTypes,
    outputShape: {
      questions: [{
        id: 'string',
        question: 'string',
        type: 'qcm',
        options: ['string', 'string', 'string', 'string'],
        correctAnswer: 'string',
        explanation: 'string',
        reference: 'string',
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
          content: 'Tu es un generateur de quiz biblique pedagogique. Genere uniquement des questions bibliques fiables, claires, non ambigues, avec une bonne reponse exacte, des distracteurs plausibles, une explication courte et une reference biblique si possible. Ne genere pas de doctrine controversee comme verite absolue. Pour les questions historiques, distingue clairement le texte biblique du contexte historique issu des Bibles d etude. Reponds uniquement en JSON valide.'
        },
        { role: 'user', content: JSON.stringify(prompt) }
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    return selectQuestions(category, level, count).map((q) => ({ ...q, source: 'fallback_local' }));
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
  })).filter(validateQuestion);
  return valid.length ? valid.slice(0, count) : selectQuestions(category, level, count).map((q) => ({ ...q, source: 'fallback_local' }));
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
    isActive: body.isActive !== false,
    createdAt: body.createdAt || new Date().toISOString()
  };
}

function sanitizeString(value) {
  return String(value ?? '').replace(/[<>]/g, '').trim();
}

function normalize(value) {
  return sanitizeString(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
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
