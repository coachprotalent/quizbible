const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const requiredFiles = [
  'server.js',
  'public/index.html',
  'public/styles.css',
  'public/app.js',
  'data/questions.json',
  'data/challenges.json',
  'deploy/nginx.quizbible.conf',
  'README.md'
];

for (const file of requiredFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

for (const file of ['data/questions.json', 'data/challenges.json', 'data/sessions.json', 'data/leaderboard.json']) {
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

console.log('Validation OK');
