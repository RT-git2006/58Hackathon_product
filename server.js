'use strict';

/* =========================================================
 * ローカルサーバー（node server.js）
 *  - このフォルダのファイルを http://localhost:8000 で配信する
 *  - /api/speech-token: Azure AI Speech の一時トークン（10 分有効）を発行する。
 *    API キーは .env に置いたままブラウザには渡さない
 *  - 依存パッケージなし（Node.js 18 以上）
 * ========================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8000;

// .env を読む（KEY=VALUE の行だけ。既に環境変数にあるものは上書きしない）
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv();

const KEY = process.env.AZURE_SPEECH_KEY || '';
const REGION = process.env.AZURE_SPEECH_REGION || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function speechToken(res) {
  if (!KEY || !REGION) {
    send(res, 404, JSON.stringify({ error: 'AZURE_SPEECH_KEY / AZURE_SPEECH_REGION が .env にありません' }), TYPES['.json']);
    return;
  }
  try {
    const r = await fetch(`https://${REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Length': '0' },
    });
    if (!r.ok) throw new Error(`issueToken ${r.status}`);
    send(res, 200, JSON.stringify({ token: await r.text(), region: REGION }), TYPES['.json']);
  } catch (err) {
    console.error('トークンを発行できません:', err.message);
    send(res, 502, JSON.stringify({ error: err.message }), TYPES['.json']);
  }
}

function serveFile(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(ROOT, rel));
  // フォルダの外・隠しファイル（.env など）・サーバー自身は配信しない
  const inside = file.startsWith(ROOT + path.sep);
  const hidden = path.relative(ROOT, file).split(path.sep).some((p) => p.startsWith('.'));
  if (!inside || hidden || path.basename(file) === 'server.js') {
    send(res, 404, 'Not Found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) send(res, 404, 'Not Found');
    else send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

http
  .createServer((req, res) => {
    if (req.url === '/api/speech-token') speechToken(res);
    else serveFile(req, res);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`http://localhost:${PORT} で起動しました`);
    console.log(KEY && REGION ? `音声認識: Azure AI Speech（${REGION}）` : '音声認識: Chrome の Web Speech API（.env に Azure のキーがありません）');
  });
