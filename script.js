'use strict';

/* =========================================================
 * 激面白字幕メーカー
 *  - Web Speech API : 音声認識（#1）
 *  - Web Audio API  : 音量・ピッチ・話速の解析（#2）
 *  - MediaPipe Pose : 体の動きの大きさ（#3）
 *  - 声+動きの複合スコアで感情の種類・強さを推定（#4）
 *  - Canvas         : リリックビデオ風に動く字幕（#5）・感情で形が変わる吹き出し（#7）
 *  - フルスクリーン   : F キー / F11（#6）
 * 語彙・フォント・配色は lexicon.js
 * ========================================================= */

// ---------- 設定 ----------
const CONFIG = {
  lang: 'ja-JP',
  fallbackFont: "'Hiragino Sans', 'Meiryo', sans-serif",
  U: 100, // レイアウト計算の基準フォントサイズ(px)。描画時に画面に合わせて拡大する
  maxWordRatio: 0.6, // 基準の単語 1 文字の高さの上限（画面の高さ比）
  captionLife: 10000, // 確定後にメインで表示し続ける時間(ms)
  bgCaptions: 2, // 背景に残す過去の字幕の数
  dbFloor: -58, // この音量(dBFS)以下は無音扱い
  dbCeil: -12, // この音量で最大
  charStagger: 14, // 1 文字ずつ出てくる間隔(ms)
  enterDur: 280, // 単語の登場アニメーションの長さ(ms)
  bubbleChance: 0.55, // 吹き出しを付ける確率
  columnsChance: 0.35, // 字幕全体を縦書きにする確率
  verticalWordChance: 0.22, // 横書きの字幕の中で、単語だけ縦にする確率
  pitchMin: 80,
  pitchMax: 600,
  poseInterval: 50, // 姿勢推定の間隔(ms)。毎フレーム回すと描画が重くなる
  mediapipeVersion: '0.10.14',
  poseModel:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};
const U = CONFIG.U;

// 感情ごとの演出（背景色・吹き出し）
const EMOTIONS = {
  neutral: { label: '平常', color: '#ffffff', glow: '#6f8cff', bg: ['#0b0b1c', '#15143a'], bubble: 'speech', fill: '#ffffff', line: '#111111' },
  joy: { label: '喜び', color: '#ffd23f', glow: '#ff9d00', bg: ['#2a1200', '#3d0c30'], bubble: 'cloud', fill: '#fff4b8', line: '#111111' },
  surprise: { label: '驚き', color: '#3fe0ff', glow: '#00a2ff', bg: ['#001a30', '#0e0e3c'], bubble: 'burst', fill: '#ffffff', line: '#111111' },
  fear: { label: '恐怖', color: '#c9a6ff', glow: '#8a2be2', bg: ['#08000f', '#1c0008'], bubble: 'wavy', fill: '#16001f', line: '#b98cff' },
  anger: { label: '怒り', color: '#ff4d4d', glow: '#ff2020', bg: ['#2c0000', '#3a0c00'], bubble: 'jagged', fill: '#ffe03a', line: '#111111' },
  sad: { label: '悲しみ', color: '#8fc4ff', glow: '#3d7bff', bg: ['#020a20', '#0a1030'], bubble: 'drip', fill: '#d8ecff', line: '#1d3b6e' },
};

// 単語の登場アニメーション
const ENTRANCES = ['slam', 'drop', 'slideL', 'slideR', 'spin', 'zoom', 'rise', 'scatter'];

// ---------- Google Fonts をファミリーごとに読み込む（1 つ失敗しても他は使える） ----------
for (const [fam, w] of Object.entries(FONT_FAMILIES)) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  const name = encodeURIComponent(fam).replace(/%20/g, '+');
  link.href = `https://fonts.googleapis.com/css2?family=${name}${w !== 400 ? `:wght@${w}` : ''}&display=swap`;
  document.head.appendChild(link);
}
const fontSpec = (fam, px = U) => `${FONT_FAMILIES[fam]} ${px}px '${fam}', ${CONFIG.fallbackFont}`;

// ---------- ユーティリティ ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const jitter = (amp) => (Math.random() - 0.5) * 2 * amp;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
function easeOutBack(t, s = 1.70158) {
  t -= 1;
  return t * t * ((s + 1) * t + s) + 1;
}
function easeOutBounce(t) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}
// 再現性のある乱数（同じ字幕・同じ単語なら毎フレーム同じ値）
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickBy = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- DOM ----------
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');
const hud = document.getElementById('hud');
const textForm = document.getElementById('textForm');
const textInput = document.getElementById('textInput');
const toastEl = document.getElementById('toast');

let W = 0;
let H = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

let toastTimer = 0;
function toast(msg, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* =========================================================
 * 解析値（音声特徴量）
 * ========================================================= */
const features = {
  volume: 0, // 0..1 音量
  db: -100,
  pitch: 0, // Hz（有声時のみ更新）
  pitchBase: 0, // 話者の平常時ピッチ（ゆっくり追従）
  pitchExcite: 0, // 0..1 平常時よりどれだけ高いか
  rate: 0, // 文字/秒
  rateNorm: 0, // 0..1
  intensity: 0, // 0..1 統合した感情の強さ
  recentPeak: 0, // 直近の intensity の最大値（認識テキストが届く前の叫びを取りこぼさない）
  // 体の動き（MediaPipe Pose）
  bodyDetected: false,
  motion: 0, // 0..1 動きの速さ
  spread: 0, // 0..1 両手の広がり
  handsUp: 0, // 0..1 手が頭より上にある度合い
  handsFace: 0, // 0..1 手で顔を覆っている度合い
};

// 声と体の動きを 1 つの強さスコアに統合（#4）
// 声が主役。黙って動いても字幕は出ないが、話しながら動くと強さが増幅される
function computeIntensity(f) {
  const voice = f.volume * 0.65 + f.pitchExcite * 0.2 + f.rateNorm * 0.15;
  const body = f.motion * 0.7 + f.spread * 0.3;
  return clamp(voice * (1 + body * 0.8) + body * voice * 0.3, 0, 1);
}

/* =========================================================
 * Web Audio API: 音量とピッチ
 * ========================================================= */
const audio = { ctx: null, analyser: null, buf: null, half: null, frame: 0 };

function initAudio(stream) {
  audio.ctx = new AudioContext();
  audio.ctx.resume();
  const src = audio.ctx.createMediaStreamSource(stream);
  audio.analyser = audio.ctx.createAnalyser();
  audio.analyser.fftSize = 2048;
  audio.analyser.smoothingTimeConstant = 0;
  src.connect(audio.analyser);
  audio.buf = new Float32Array(audio.analyser.fftSize);
  audio.half = new Float32Array(audio.analyser.fftSize / 2);
}

function updateAudio() {
  if (!audio.analyser) return;
  const buf = audio.buf;
  audio.analyser.getFloatTimeDomainData(buf);

  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  features.db = 20 * Math.log10(rms + 1e-8);
  const v = clamp((features.db - CONFIG.dbFloor) / (CONFIG.dbCeil - CONFIG.dbFloor), 0, 1);
  // 立ち上がりは即座に、減衰はゆっくり
  features.volume += (v - features.volume) * (v > features.volume ? 0.8 : 0.1);

  // ピッチ推定は 1/2 に間引いた波形で 2 フレームに 1 回、声がある時だけ（計算量を約 1/5 に）
  audio.frame++;
  if (v > 0.15 && audio.frame % 2 === 0) {
    const half = audio.half;
    for (let i = 0; i < half.length; i++) half[i] = (buf[i * 2] + buf[i * 2 + 1]) * 0.5;
    const p = detectPitch(half, audio.ctx.sampleRate / 2);
    if (p > 0) {
      features.pitch = features.pitch ? lerp(features.pitch, p, 0.4) : p;
      features.pitchBase = features.pitchBase ? lerp(features.pitchBase, p, 0.005) : p;
    }
  }
  const target = features.pitchBase ? clamp((features.pitch / features.pitchBase - 1) / 0.5, 0, 1) : 0;
  features.pitchExcite = lerp(features.pitchExcite, v > 0.1 ? target : 0, 0.2);
}

// 自己相関によるピッチ推定（精度より軽さ優先）
function detectPitch(buf, sampleRate) {
  const n = buf.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += buf[i] * buf[i];
  if (energy < 1e-3) return -1;

  const minLag = Math.floor(sampleRate / CONFIG.pitchMax);
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / CONFIG.pitchMin));
  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < n - lag; i++) c += buf[i] * buf[i + lag];
    c /= energy;
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }
  if (bestCorr < 0.3 || bestLag < 0) return -1;
  return sampleRate / bestLag;
}

/* =========================================================
 * MediaPipe Pose Landmarker: 体の動き
 * ========================================================= */
const video = document.getElementById('cam');
const camView = document.getElementById('camView');
const camCtx = camView.getContext('2d');
const body = { landmarker: null, lastVideoTime: -1, lastRun: 0, prev: null, prevTime: 0, lm: null };

// 動き量の計算に使う点: 鼻・両肩・両肘・両手首
const MOTION_POINTS = [0, 11, 12, 13, 14, 15, 16];
// プレビューに描く骨格の線
const SKELETON = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];

async function initBody() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    console.error(err);
    toast('カメラを使えません（声だけで動作します）', 4000);
    return;
  }

  try {
    toast('動き検出を準備中…', 10000);
    const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CONFIG.mediapipeVersion}`;
    // classic script から ES モジュールを動的 import（ビルド不要のまま使うため）
    const { FilesetResolver, PoseLandmarker } = await import(`${base}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
    const create = (delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: CONFIG.poseModel, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    // GPU が使えない PC では CPU にフォールバック
    body.landmarker = await create('GPU').catch(() => create('CPU'));
    camView.width = 320;
    camView.height = 240;
    toast('動き検出 ON（V キーでカメラ表示）');
  } catch (err) {
    console.error(err);
    toast('動き検出を読み込めませんでした（声だけで動作します）', 5000);
  }
}

function updateBody(now) {
  if (!body.landmarker || video.readyState < 2 || video.currentTime === body.lastVideoTime) return;
  if (now - body.lastRun < CONFIG.poseInterval) return;
  body.lastRun = now;
  body.lastVideoTime = video.currentTime;
  const res = body.landmarker.detectForVideo(video, now);
  const lm = res.landmarks && res.landmarks[0];
  body.lm = lm || null;

  if (!lm) {
    features.bodyDetected = false;
    features.motion = lerp(features.motion, 0, 0.2);
    features.spread = lerp(features.spread, 0, 0.2);
    features.handsUp = lerp(features.handsUp, 0, 0.2);
    features.handsFace = lerp(features.handsFace, 0, 0.2);
    body.prev = null;
    return;
  }
  features.bodyDetected = true;

  // 肩幅を基準にして、カメラからの距離に依存しない値にする
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const shoulder = Math.max(0.05, dist(lm[11], lm[12]));
  const visible = (p) => (p.visibility ?? 1) > 0.5;

  // 動きの速さ（肩幅/秒）
  let raw = 0;
  if (body.prev) {
    const dtSec = Math.max(0.016, (now - body.prevTime) / 1000);
    let d = 0;
    let n = 0;
    for (const id of MOTION_POINTS) {
      if (visible(lm[id]) && visible(body.prev[id])) {
        d += dist(lm[id], body.prev[id]);
        n++;
      }
    }
    if (n) raw = clamp(d / n / shoulder / dtSec / 4, 0, 1);
  }
  // 大きく動いた瞬間はすぐ反映し、ゆっくり落ち着く
  features.motion = lerp(features.motion, raw, raw > features.motion ? 0.7 : 0.1);

  const [nose, lw, rw] = [lm[0], lm[15], lm[16]];
  const wristsVisible = visible(lw) && visible(rw);
  const spread = wristsVisible ? clamp((dist(lw, rw) / shoulder - 1.5) / 2.5, 0, 1) : 0;
  // 画像座標は y が下向きなので「手首の y < 鼻の y」が手を挙げた状態
  const up = ((visible(lw) && lw.y < nose.y ? 1 : 0) + (visible(rw) && rw.y < nose.y ? 1 : 0)) / 2;
  const face = ((visible(lw) && dist(lw, nose) < shoulder * 0.5 ? 1 : 0) + (visible(rw) && dist(rw, nose) < shoulder * 0.5 ? 1 : 0)) / 2;
  features.spread = lerp(features.spread, spread, 0.35);
  features.handsUp = lerp(features.handsUp, up, 0.35);
  features.handsFace = lerp(features.handsFace, face, 0.35);

  body.prev = lm.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility }));
  body.prevTime = now;
}

// 右下のカメラプレビュー（鏡像＋骨格）
function drawCamView() {
  if (camView.hidden || !body.landmarker) return;
  const w = camView.width;
  const h = camView.height;
  camCtx.save();
  camCtx.translate(w, 0);
  camCtx.scale(-1, 1);
  camCtx.globalAlpha = 0.6;
  camCtx.drawImage(video, 0, 0, w, h);
  camCtx.globalAlpha = 1;
  const lm = body.lm;
  if (lm) {
    const color = `hsl(${lerp(200, 0, features.motion)}, 100%, 60%)`;
    camCtx.strokeStyle = color;
    camCtx.fillStyle = color;
    camCtx.lineWidth = 3;
    for (const [a, b] of SKELETON) {
      camCtx.beginPath();
      camCtx.moveTo(lm[a].x * w, lm[a].y * h);
      camCtx.lineTo(lm[b].x * w, lm[b].y * h);
      camCtx.stroke();
    }
    for (const id of MOTION_POINTS) {
      camCtx.beginPath();
      camCtx.arc(lm[id].x * w, lm[id].y * h, 4, 0, Math.PI * 2);
      camCtx.fill();
    }
  }
  camCtx.restore();
}

/* =========================================================
 * テキスト解析・感情推定
 * ========================================================= */
// 単語分割はブラウザ内蔵の辞書（Intl.Segmenter）を使い、助詞などの短いひらがなは前の単語にくっつけて文節っぽくする
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
const RE_HIRA = /^[ぁ-ゟー]+$/;
const RE_KANJI_END = /[一-鿿々]$/;
const RE_KANJI_START = /^[一-鿿々]/;
const MAX_CHUNK = 8;

function splitChunks(text) {
  let segs;
  if (segmenter) {
    segs = [...segmenter.segment(text)].map((s) => ({ t: s.segment, word: s.isWordLike }));
  } else {
    // Segmenter が無いブラウザ向け: 文字種の切れ目で分ける
    segs = (text.match(/[一-鿿々]+[ぁ-ゟ]*|[゠-ヿー]+|[ぁ-ゟ]+|[A-Za-z0-9]+|./g) || []).map((t) => ({
      t,
      word: /[^\s、。！？!?]/.test(t),
    }));
  }
  const out = [];
  for (const s of segs) {
    const t = s.t.replace(/\s+/g, '');
    if (!t) continue;
    const prev = out[out.length - 1];
    const attach =
      prev !== undefined &&
      prev.length + t.length <= MAX_CHUNK + 2 &&
      (!s.word || // 句読点・記号
        (RE_HIRA.test(t) && (t.length <= 2 || prev.length === 1)) || // 助詞・送り仮名
        (RE_KANJI_END.test(prev) && RE_KANJI_START.test(t) && prev.length + t.length <= 4)); // 切れすぎた熟語
    if (attach) out[out.length - 1] = prev + t;
    else out.push(t);
  }
  // 長すぎる単語は分割（画面いっぱいに大きく見せるため）
  const res = [];
  for (const t of out) {
    if (t.length <= MAX_CHUNK + 2) res.push(t);
    else for (let i = 0; i < t.length; i += MAX_CHUNK) res.push(t.slice(i, i + MAX_CHUNK));
  }
  return res;
}

// 声と体の特徴から推定した感情スコア（キーワードが無くても反応させる）
function prosodyScores(f) {
  return {
    // 声が裏返る＋大きく動く → 驚き
    surprise: f.pitchExcite * f.volume * 1.2 + f.motion * f.pitchExcite * 0.8,
    // 低めの大声＋激しい動き → 怒り
    anger: (f.volume > 0.7 && f.pitchExcite < 0.25 ? (f.volume - 0.7) * 3 : 0) + (f.volume > 0.6 ? f.motion * 0.5 : 0),
    // 声が高く弾む／両手を挙げる → 喜び
    joy: f.pitchExcite * f.rateNorm * 0.8 + f.handsUp * 0.9,
    // 小声で早口／手で顔を覆う → 恐怖
    fear: (f.volume < 0.25 && f.rateNorm > 0.5 ? 0.4 : 0) + f.handsFace * 1.0,
    // 小声でゆっくり・低い → 悲しみ
    sad: f.volume > 0.05 && f.volume < 0.3 && f.rateNorm < 0.2 && f.pitchExcite < 0.1 ? 0.3 : 0,
  };
}

function pickEmotion(kw, prosody) {
  const weight = { joy: 1.2, surprise: 1.0, fear: 1.4, anger: 1.2, sad: 1.2 };
  let best = 'neutral';
  let bestScore = 0.55;
  for (const k of Object.keys(weight)) {
    const s = (kw[k] || 0) * weight[k] + (prosody[k] || 0);
    if (s > bestScore) {
      best = k;
      bestScore = s;
    }
  }
  return { type: best, strength: best === 'neutral' ? 0 : clamp(bestScore / 2, 0.3, 1) };
}

/* =========================================================
 * 字幕: 単語（Chunk）と発話（Caption）
 * ========================================================= */
// 縦書きで 90° 回す文字 / 右上に寄せる文字
const RE_V_ROTATE = /[ー－―—〜～…‥\-=＝→←()（）「」『』【】[\]<>＜＞A-Za-z0-9ａ-ｚＡ-Ｚ０-９]/;
const RE_V_PUNCT = /[、。，．]/;
const RE_V_SMALL = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/;

class Chunk {
  constructor(cap, index, text, now) {
    this.cap = cap;
    this.index = index;
    const r = mulberry32(cap.seed * 131 + index * 7919);
    this.roll = { font: r(), pal: r(), style: r(), size: r(), vert: r(), enter: r() };
    this.entrance = pickBy(ENTRANCES, this.roll.enter);
    this.dir = r() < 0.5 ? -1 : 1;
    this.tilt = (r() - 0.5) * 0.22;
    this.phase = r() * Math.PI * 2;
    this.born = now;
    this.vol = cap.volOverride ?? Math.max(features.intensity, features.recentPeak * 0.7);
    this.chars = [];
    this.text = '';
    this.x = null; // レイアウト上の現在位置（基準単位、字幕の中心が原点）
    this.y = 0;
    this.s = 1;
    this.setText(text, now);
  }

  setText(text, now) {
    if (text === this.text) return;
    const old = this.chars;
    const chars = [];
    let delay = 0;
    for (let i = 0; i < text.length; i++) {
      if (old[i] && old[i].ch === text[i]) chars.push(old[i]);
      else {
        chars.push({ ch: text[i], born: now + delay, w: 0 });
        delay += CONFIG.charStagger;
      }
    }
    this.chars = chars;
    this.text = text;
    this.category = classifyChunk(text);
    const cat = CATEGORIES[this.category];
    this.family = pickBy(cat.fonts, this.roll.font);
    this.font = fontSpec(this.family);
    this.style = pickBy(cat.styles, this.roll.style);
    this.palIndex = Math.floor(this.roll.pal * cat.palettes.length);
    this.vertical =
      this.cap.mode === 'columns' || (text.length >= 2 && text.length <= 6 && this.roll.vert < CONFIG.verticalWordChance);
    this.measured = false;
    this.grad = null;
    // Web フォントは文字種ごとに分割配信されるので、使う文字を先読みし、読めたら測り直す
    document.fonts
      .load(fontSpec(this.family, 64), text)
      .then(() => {
        this.measured = false;
      })
      .catch(() => {});
  }

  get palette() {
    const p = CATEGORIES[this.category].palettes;
    return p[this.palIndex % p.length];
  }

  measure() {
    if (this.measured) return;
    ctx.font = this.font;
    for (const c of this.chars) c.w = this.vertical ? U : ctx.measureText(c.ch).width;
    this.measured = true;
    this.grad = null;
  }

  // 大きさの重み: 内容のある単語・叫んだ単語ほど大きい
  weight() {
    let s = 0.85 + this.roll.size * 0.3;
    if (this.category !== 'neutral') s *= 1.3;
    if (/[!！]/.test(this.text)) s *= 1.2;
    if (this.text.length <= 2) s *= 1.15;
    return s * (0.7 + this.vol * 0.8);
  }

  // 基準単位での大きさと、文字ごとの位置
  box() {
    this.measure();
    let off = 0;
    if (this.vertical) {
      const step = U * 1.02;
      const h = this.chars.length * step;
      for (const c of this.chars) {
        c.ox = 0;
        c.oy = -h / 2 + off + step / 2;
        off += step;
      }
      return { w: U * 1.15, h };
    }
    const total = this.chars.reduce((a, c) => a + c.w, 0);
    for (const c of this.chars) {
      c.ox = -total / 2 + off + c.w / 2;
      c.oy = 0;
      off += c.w;
    }
    return { w: total, h: U * 1.15 };
  }
}

class Caption {
  constructor(now) {
    this.seed = Math.floor(Math.random() * 1e9);
    const r = mulberry32(this.seed);
    this.mode = r() < CONFIG.columnsChance ? 'columns' : 'rows';
    this.zigzag = r() < 0.6; // 行（列）ごとに左右（上下）に寄せる
    this.bubble = r() < CONFIG.bubbleChance;
    this.tailDir = r() < 0.5 ? -1 : 1;
    this.offRoll = [r() * 2 - 1, r() * 2 - 1];
    this.tilt = this.mode === 'rows' ? (r() - 0.5) * 0.12 : (r() - 0.5) * 0.05;
    this.born = now;
    this.text = '';
    this.chunks = [];
    this.live = true;
    this.committedAt = 0;
    this.state = 'main'; // main → leaving → bg
    this.leftAt = 0;
    this.peak = features.recentPeak;
    this.finalI = 0;
    this.volOverride = null;
    this.prosody = { joy: 0, surprise: 0, fear: 0, anger: 0, sad: 0 };
    this.kw = {};
    this.emotion = 'neutral';
    this.strength = 0;
    this.scale = 0; // 基準単位 → 画面 px の倍率
    this.cx = W / 2;
    this.cy = H / 2;
    this.bw = U;
    this.bh = U;
    this.limitIdx = -1;
    this.alpha = 1;
    this.dead = false;
  }

  setText(text, now) {
    this.text = text;
    const parts = splitChunks(text);
    for (let i = 0; i < parts.length; i++) {
      if (this.chunks[i]) this.chunks[i].setText(parts[i], now);
      else {
        this.chunks.push(new Chunk(this, i, parts[i], now));
        if (this.chunks.length > 1) onNewChunk();
      }
    }
    this.chunks.length = parts.length;
    // 隣り合う単語が同じ配色にならないようにする
    for (let i = 1; i < this.chunks.length; i++) {
      const a = this.chunks[i - 1];
      const b = this.chunks[i];
      if (a.category === b.category && a.palIndex === b.palIndex) b.palIndex++;
    }
    // 単語のカテゴリから感情のキーワードスコアを作る
    const kw = {};
    for (const k of this.chunks) {
      for (const [e, v] of Object.entries(CATEGORIES[k.category].emo)) kw[e] = (kw[e] || 0) + v;
    }
    kw.surprise = (kw.surprise || 0) + (text.match(/[!！]/g) || []).length * 0.4 + (text.match(/[?？]/g) || []).length * 0.3;
    this.kw = kw;
  }

  commit(now) {
    this.live = false;
    this.committedAt = now;
    this.finalI = clamp(this.peak * 0.8 + 0.1, 0, 1);
    const emo = pickEmotion(this.kw, this.prosody);
    this.emotion = emo.type;
    this.strength = emo.strength;
    if (this.finalI > 0.55 || this.emotion !== 'neutral') impact(this);
    else cam.punch += 0.04;
  }

  leave(now) {
    if (this.state !== 'main') return;
    this.state = 'leaving';
    this.leftAt = now;
  }

  update(now) {
    if (this.live) {
      this.peak = Math.max(this.peak, features.recentPeak);
      if (features.volume > 0.1) {
        // 発話中の声の特徴を感情スコアとして蓄積
        const p = prosodyScores(features);
        for (const k in this.prosody) this.prosody[k] = lerp(this.prosody[k], p[k], 0.1);
      }
      const emo = pickEmotion(this.kw, this.prosody);
      this.emotion = emo.type;
      this.strength = emo.strength;
      // 今しゃべっている単語は、声の大きさに合わせて育つ
      const last = this.chunks[this.chunks.length - 1];
      if (last && this.volOverride === null) last.vol = Math.max(last.vol, features.intensity);
    } else if (this.state === 'main' && now - this.committedAt > CONFIG.captionLife) {
      this.leave(now);
    }

    if (this.state === 'main') this.layout();

    // 単語を目標位置へ滑らかに動かす（行の組み替えもアニメーションになる）
    for (const k of this.chunks) {
      if (k.x === null) {
        k.x = k.tx;
        k.y = k.ty;
        k.s = k.ts;
      }
      k.x = lerp(k.x, k.tx, 0.22);
      k.y = lerp(k.y, k.ty, 0.22);
      k.s = lerp(k.s, k.ts, 0.22);
    }

    if (this.state === 'bg') {
      const age = now - this.leftAt;
      if (age > CONFIG.captionLife) this.alpha -= 0.01;
      if (this.alpha <= 0) this.dead = true;
    }
  }

  // 単語を行（縦書きなら列）に詰めて、画面いっぱいになる倍率を求める
  layout() {
    const items = this.chunks.map((k) => {
      const b = k.box();
      const s = k.weight();
      return { k, s, w: b.w * s, h: b.h * s };
    });
    if (!items.length) return;
    const cols = this.mode === 'columns';
    const gap = U * 0.14;
    const main = (it) => (cols ? it.h : it.w);
    const total = items.reduce((a, it) => a + main(it) + gap, 0);
    const biggest = Math.max(...items.map(main));

    const availW = W * (this.bubble ? 0.8 : 0.95);
    const availH = H * (this.bubble ? 0.76 : 0.92);
    const padX = this.bubble ? U * 0.35 : 0;
    const fitOf = (f) => Math.min(availW / (f.bw + padX * 2), availH / (f.bh + padX * 2));

    // 1 行（列）の長さの候補をいくつか試し、いちばん大きく表示できるものを選ぶ
    const N = 10;
    let bestIdx = 0;
    let bestFit = -1;
    const flows = [];
    for (let i = 0; i < N; i++) {
      const limit = lerp(biggest, total, i / (N - 1)) + 1;
      const f = this.flow(items, limit, gap, cols);
      flows.push(f);
      const fit = fitOf(f);
      if (fit > bestFit) {
        bestFit = fit;
        bestIdx = i;
      }
    }
    // 文字が増えるたびに組み方がコロコロ変わらないよう、前回の組み方がほぼ同じ大きさなら維持
    if (this.limitIdx >= 0 && fitOf(flows[this.limitIdx]) > bestFit * 0.9) bestIdx = this.limitIdx;
    this.limitIdx = bestIdx;
    const f = flows[bestIdx];
    for (const pl of f.places) {
      pl.k.tx = pl.x;
      pl.k.ty = pl.y;
      pl.k.ts = pl.s;
    }
    this.bw = f.bw;
    this.bh = f.bh;

    // 声の大きさで画面の埋まり具合を変える（小声でも 9 割は埋める）
    const I = this.live ? features.intensity : this.finalI;
    const fill = lerp(0.9, 1, I);
    const target = Math.min(fitOf(f) * fill, (H * CONFIG.maxWordRatio) / U);
    this.scale = this.scale ? lerp(this.scale, target, 0.25) : target;

    // 余白があれば、字幕ごとに中心位置をずらして単調にしない
    const spareX = Math.max(0, (availW - (f.bw + padX * 2) * this.scale) / 2);
    const spareY = Math.max(0, (availH - (f.bh + padX * 2) * this.scale) / 2);
    this.cx = lerp(this.cx, W / 2 + this.offRoll[0] * spareX, 0.2);
    this.cy = lerp(this.cy, H / 2 + this.offRoll[1] * spareY, 0.2);
  }

  flow(items, limit, gap, cols) {
    // 横書き: 行を上から / 縦書き: 列を右から
    const lines = [];
    let line = { items: [], len: 0, cross: 0 };
    for (const it of items) {
      const len = cols ? it.h : it.w;
      const cross = cols ? it.w : it.h;
      if (line.items.length && line.len + gap + len > limit) {
        lines.push(line);
        line = { items: [], len: 0, cross: 0 };
      }
      line.len += (line.items.length ? gap : 0) + len;
      line.cross = Math.max(line.cross, cross);
      line.items.push(it);
    }
    lines.push(line);
    const mainLen = Math.max(...lines.map((l) => l.len));
    const crossLen = lines.reduce((a, l) => a + l.cross, 0) + gap * 0.5 * (lines.length - 1);

    const places = [];
    let crossPos = -crossLen / 2;
    lines.forEach((l, li) => {
      // zigzag: 行ごとに左寄せ・右寄せを交互に（歌詞動画っぽいリズム）
      let start = -l.len / 2;
      if (this.zigzag && lines.length > 1) start = li % 2 === 0 ? -mainLen / 2 : mainLen / 2 - l.len;
      let pos = start;
      for (const it of l.items) {
        const len = cols ? it.h : it.w;
        const c = crossPos + l.cross / 2;
        const m = pos + len / 2;
        // 縦書きは右の列から
        places.push({ k: it.k, x: cols ? -c : m, y: cols ? m : c, s: it.s });
        pos += len + gap;
      }
      crossPos += l.cross + gap * 0.5;
    });
    return cols ? { bw: crossLen, bh: mainLen, places } : { bw: mainLen, bh: crossLen, places };
  }
}

/* =========================================================
 * 字幕の管理
 * ========================================================= */
const captions = [];
let liveCaption = null; // 発話中（認識途中）の字幕
const rings = []; // 衝撃波
const particles = []; // 紙吹雪・火花
const fx = { shake: 0, flashColor: '#000', flash: 0 };
const cam = { punch: 0, rot: 0 };

function newCaption(now) {
  for (const c of captions) c.leave(now);
  const c = new Caption(now);
  captions.push(c);
  // 背景に残す過去の字幕は数を絞る
  const olds = captions.filter((o) => o.state !== 'main');
  for (let i = 0; i < olds.length - CONFIG.bgCaptions; i++) olds[i].dead = true;
  cam.punch += 0.06;
  return c;
}

// 単語が増えるたびに画面がドンと寄る
function onNewChunk() {
  const I = features.intensity;
  cam.punch += 0.025 + I * 0.07;
  cam.rot += jitter(0.02 + I * 0.03);
  if (I > 0.6) fx.shake = Math.max(fx.shake, I * 10);
}

// 大きな声・強い感情で確定したときの演出
function impact(c) {
  const emo = EMOTIONS[c.emotion];
  fx.shake = Math.max(fx.shake, 8 + c.finalI * 26);
  fx.flash = Math.max(fx.flash, 0.2 + 0.4 * c.finalI);
  fx.flashColor = emo.glow;
  cam.punch += 0.08 + 0.12 * c.finalI;
  rings.push({ x: c.cx, y: c.cy, r: 30, a: 0.9, color: emo.glow, speed: 1 + c.finalI * 2 });
  burstParticles(c.cx, c.cy, 30 + Math.round(c.finalI * 60), c.emotion);
}

function burstParticles(x, y, n, emotion) {
  const colors = {
    joy: ['#ffd23f', '#ff4d8d', '#3fe0ff', '#7dff6a', '#ffffff'],
    surprise: ['#ffffff', '#3fe0ff', '#fff176'],
    fear: ['#8a2be2', '#ff0044', '#2a0033'],
    anger: ['#ff2020', '#ffb000', '#ffffff'],
    sad: ['#8fc4ff', '#d8ecff'],
    neutral: ['#ffffff', '#ffd23f', '#3fe0ff', '#ff4d8d'],
  }[emotion];
  for (let i = 0; i < n && particles.length < 400; i++) {
    const a = rand(0, Math.PI * 2);
    const sp = rand(4, 18);
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - (emotion === 'sad' ? -2 : 4),
      rot: rand(0, 6),
      vr: jitter(0.4),
      size: rand(8, 22),
      color: colors[i % colors.length],
      life: 1,
      decay: rand(0.008, 0.02),
      shape: emotion === 'sad' ? 'drop' : emotion === 'anger' || emotion === 'surprise' ? 'spark' : 'rect',
    });
  }
}

// 認識途中のテキスト
function updateLive(text) {
  const now = performance.now();
  if (!liveCaption) liveCaption = newCaption(now);
  liveCaption.setText(text, now);
}

// 認識が確定したテキスト
function commitUtterance(text) {
  const now = performance.now();
  text = text.trim();
  if (!text) return;
  const c = liveCaption || newCaption(now);
  liveCaption = null;
  c.setText(text, now);
  c.commit(now);
}

// 手入力（音声認識が使えない時の代替）。「!」の数で強さを決める
function commitTyped(text) {
  const now = performance.now();
  if (liveCaption) liveCaption = null;
  const c = newCaption(now);
  const bangs = (text.match(/[!！]/g) || []).length;
  c.volOverride = clamp(0.35 + bangs * 0.2, 0, 1);
  c.peak = Math.max(features.recentPeak, c.volOverride);
  c.setText(text, now);
  c.commit(now);
}

/* =========================================================
 * Web Speech API: 音声認識
 * ========================================================= */
let recognition = null;
let running = false;

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast('このブラウザは音声認識に対応していません（Chrome 推奨）。Enter で手入力できます', 6000);
    return;
  }
  recognition = new SR();
  recognition.lang = CONFIG.lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) commitUtterance(r[0].transcript);
      else interim += r[0].transcript;
    }
    if (interim) updateLive(interim);
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      running = false;
      toast('マイクの使用が許可されていません', 5000);
    } else if (e.error === 'network') {
      toast('音声認識にはネット接続が必要です（Enter で手入力可）', 5000);
    } else {
      toast('音声認識エラー: ' + e.error);
    }
  };

  // Chrome は無音が続くと止まるので即座に再開する（待つと再開までの発話を取りこぼす）
  recognition.onend = () => {
    // 確定されないまま途切れた字幕は、その時点のテキストで確定させる
    if (liveCaption && liveCaption.text) commitUtterance(liveCaption.text);
    if (running) startRecognition();
  };

  running = true;
  startRecognition();
}

function startRecognition() {
  try {
    recognition.start();
  } catch (err) {
    // すでに開始済みの場合は少し待って再試行
    setTimeout(() => {
      try {
        recognition.start();
      } catch (e) {
        /* 開始済み */
      }
    }, 50);
  }
}

/* =========================================================
 * 描画: 背景
 * ========================================================= */
const bgState = { a: hexToRgb('#0b0b1c'), b: hexToRgb('#15143a'), speed: 0 };
let speedLines = [];
let speedLinesAt = 0;

function currentEmotion() {
  const main = captions.find((c) => c.state === 'main');
  return main ? main.emotion : 'neutral';
}

function drawBackground(now, emotion, I) {
  const e = EMOTIONS[emotion];
  const ta = hexToRgb(e.bg[0]);
  const tb = hexToRgb(e.bg[1]);
  for (let i = 0; i < 3; i++) {
    bgState.a[i] = lerp(bgState.a[i], ta[i], 0.05);
    bgState.b[i] = lerp(bgState.b[i], tb[i], 0.05);
  }
  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  // ゆっくり回転するグラデーション
  const ang = now / 6000;
  const g = ctx.createLinearGradient(
    W / 2 + Math.cos(ang) * W,
    H / 2 + Math.sin(ang) * H,
    W / 2 - Math.cos(ang) * W,
    H / 2 - Math.sin(ang) * H,
  );
  g.addColorStop(0, rgb(bgState.a));
  g.addColorStop(1, rgb(bgState.b));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 声に合わせて背景が脈打つ（文字が出る前から「聞こえている」ことが分かる）
  const v = features.volume;
  if (v > 0.02) {
    const rg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * (0.3 + v * 0.5));
    rg.addColorStop(0, e.glow);
    rg.addColorStop(1, 'transparent');
    ctx.globalAlpha = v * 0.45;
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // 集中線（驚き・怒り・大声のとき）
  const want = emotion === 'surprise' || emotion === 'anger' ? 0.6 + I * 0.4 : clamp((I - 0.45) * 2, 0, 1);
  bgState.speed = lerp(bgState.speed, want, 0.1);
  if (bgState.speed > 0.03) {
    if (now - speedLinesAt > 70) {
      speedLinesAt = now;
      speedLines = [];
      for (let i = 0; i < 90; i++) speedLines.push({ a: rand(0, Math.PI * 2), w: rand(0.004, 0.018), r: rand(0.32, 0.55) });
    }
    const R = Math.hypot(W, H);
    const m = Math.min(W, H);
    ctx.fillStyle = emotion === 'anger' ? '#ffd0d0' : '#ffffff';
    ctx.globalAlpha = bgState.speed * 0.35;
    ctx.beginPath();
    for (const l of speedLines) {
      const r0 = l.r * m;
      ctx.moveTo(W / 2 + Math.cos(l.a) * r0, H / 2 + Math.sin(l.a) * r0);
      ctx.lineTo(W / 2 + Math.cos(l.a - l.w) * R, H / 2 + Math.sin(l.a - l.w) * R);
      ctx.lineTo(W / 2 + Math.cos(l.a + l.w) * R, H / 2 + Math.sin(l.a + l.w) * R);
      ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 画面フラッシュ
  if (fx.flash > 0.005) {
    const fg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    fg.addColorStop(0, fx.flashColor);
    fg.addColorStop(1, 'transparent');
    ctx.globalAlpha = fx.flash;
    ctx.fillStyle = fg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    fx.flash *= 0.88;
  }
}

/* =========================================================
 * 描画: 吹き出し（感情で輪郭が変わる）
 * ========================================================= */
function bubblePath(shape, a, b, now, seed) {
  const r = mulberry32(seed);
  const t = now / 1000;
  const N = 160;
  const spikes = shape === 'burst' ? 30 : 15;
  const amps = Array.from({ length: spikes }, () => r());
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    // 角丸の四角っぽい楕円（文字の四隅を覆いやすい）
    let x = a * Math.sign(c) * Math.sqrt(Math.abs(c));
    let y = b * Math.sign(s) * Math.sqrt(Math.abs(s));
    let f = 1;
    switch (shape) {
      case 'burst': {
        // ウニフラッシュ: 細かいトゲ
        const k = (i / N) * spikes;
        const frac = k - Math.floor(k);
        f = 1 + (1 - Math.abs(frac * 2 - 1)) * (0.14 + amps[Math.floor(k) % spikes] * 0.12) + Math.sin(t * 20 + i) * 0.004;
        break;
      }
      case 'jagged': {
        // 怒り: 大きく不揃いなギザギザ
        const k = (i / N) * spikes;
        const frac = k - Math.floor(k);
        f = 0.96 + (1 - Math.abs(frac * 2 - 1)) * (0.18 + amps[Math.floor(k) % spikes] * 0.25) + jitter(0.006);
        break;
      }
      case 'cloud':
        // 喜び: もこもこ
        f = 1 + 0.07 * Math.abs(Math.sin(th * 8 + t * 0.8));
        break;
      case 'wavy':
        // 恐怖: 不気味に波打つ
        f = 1 + 0.04 * Math.sin(th * 9 + t * 4) + 0.025 * Math.sin(th * 17 - t * 6);
        break;
      case 'drip':
        // 悲しみ: ゆっくりたゆたう
        f = 1 + 0.03 * Math.sin(th * 5 + t * 1.2);
        break;
    }
    x *= f;
    y *= f;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawBubble(c, now) {
  const e = EMOTIONS[c.emotion];
  const shape = e.bubble;
  const pad = U * 0.35;
  const age = (now - c.born) / 320;
  const pop = age < 1 ? easeOutBack(clamp(age, 0, 1), 2.5) : 1;
  const breathe = 1 + (c.live ? features.volume * 0.06 : 0) + Math.sin(now / 500) * 0.01;
  const a = ((c.bw / 2) * 1.2 + pad) * pop * breathe;
  const b = ((c.bh / 2) * 1.2 + pad) * pop * breathe;
  if (a <= 0 || b <= 0) return;
  const lw = Math.max(6, H * 0.012) / c.scale;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = e.line;
  ctx.fillStyle = e.fill;
  // しっぽ（普通・喜び・悲しみの吹き出しだけ）
  const tail = shape === 'speech' || shape === 'cloud' || shape === 'drip';
  const tailPath = () => {
    ctx.beginPath();
    ctx.moveTo(c.tailDir * a * 0.25, b * 0.8);
    ctx.lineTo(c.tailDir * a * 0.62, b * 1.35);
    ctx.lineTo(c.tailDir * a * 0.5, b * 0.7);
    ctx.closePath();
  };
  // 影
  ctx.save();
  ctx.translate(lw * 1.4, lw * 1.4);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  bubblePath(shape, a, b, now, c.seed);
  ctx.fill();
  ctx.restore();
  if (tail) {
    tailPath();
    ctx.stroke();
  }
  bubblePath(shape, a, b, now, c.seed);
  ctx.stroke();
  if (tail) {
    tailPath();
    ctx.fill();
  }
  bubblePath(shape, a, b, now, c.seed);
  ctx.fill();
  // 悲しみは涙のしずく
  if (shape === 'drip') {
    ctx.fillStyle = e.line;
    for (let i = 0; i < 3; i++) {
      const x = -a * 0.5 + i * a * 0.45;
      const y = b * 1.05 + ((now / 12 + i * 60) % 90) * (U / 60);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(x, y, U * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/* =========================================================
 * 描画: 文字（テレビのテロップ風）
 * ========================================================= */
function glyph(k, ch, x, y, simple) {
  const [c1, c2] = k.palette;
  if (simple) {
    // 背景に残った過去の字幕は軽い描き方で
    ctx.fillStyle = c1;
    ctx.fillText(ch, x, y);
    return;
  }
  if (!k.grad) {
    k.grad = ctx.createLinearGradient(0, -U * 0.45, 0, U * 0.45);
    k.grad.addColorStop(0, '#ffffff');
    k.grad.addColorStop(0.3, c1);
    k.grad.addColorStop(1, c2);
  }
  // 影
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 34;
  ctx.strokeText(ch, x + 7, y + 9);

  switch (k.style) {
    case 'telop': // グラデ文字＋白フチ＋黒フチ
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 32;
      ctx.strokeText(ch, x, y);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 15;
      ctx.strokeText(ch, x, y);
      ctx.fillStyle = k.grad;
      ctx.fillText(ch, x, y);
      break;
    case 'pop': // 白文字＋色フチ＋黒フチ
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 36;
      ctx.strokeText(ch, x, y);
      ctx.strokeStyle = c2;
      ctx.lineWidth = 20;
      ctx.strokeText(ch, x, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(ch, x, y);
      break;
    case 'solid': // 単色＋濃い色の太フチ
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 34;
      ctx.strokeText(ch, x, y);
      ctx.strokeStyle = c2;
      ctx.lineWidth = 22;
      ctx.strokeText(ch, x, y);
      ctx.fillStyle = c1;
      ctx.fillText(ch, x, y);
      break;
    case 'neon': // 光るフチ
      ctx.strokeStyle = c2;
      ctx.globalAlpha *= 0.35;
      ctx.lineWidth = 40;
      ctx.strokeText(ch, x, y);
      ctx.globalAlpha /= 0.35;
      ctx.strokeStyle = c2;
      ctx.lineWidth = 16;
      ctx.strokeText(ch, x, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(ch, x, y);
      break;
    case 'horror': { // グリッチ残像＋暗い文字
      const ga = ctx.globalAlpha;
      ctx.globalAlpha = ga * 0.7;
      ctx.fillStyle = '#ff0044';
      ctx.fillText(ch, x + jitter(10), y + jitter(5));
      ctx.fillStyle = '#00e5ff';
      ctx.fillText(ch, x + jitter(10), y + jitter(5));
      ctx.globalAlpha = ga;
      ctx.strokeStyle = c2;
      ctx.lineWidth = 22;
      ctx.strokeText(ch, x, y);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 10;
      ctx.strokeText(ch, x, y);
      ctx.fillStyle = c1;
      ctx.fillText(ch, x, y);
      break;
    }
  }
}

function drawChunk(c, k, now, I, simple) {
  if (k.x === null) return;
  const cat = k.category;
  const t = (now - k.born) / 1000;
  const p = clamp((now - k.born) / CONFIG.enterDur, 0, 1);
  const toUnit = 1 / Math.max(0.01, c.scale); // 画面 px → 基準単位

  // ---- 登場アニメーション ----
  let ex = 0;
  let ey = 0;
  let er = 0;
  let es = 1;
  let ea = 1;
  if (p < 1 && !simple) {
    switch (k.entrance) {
      case 'slam': // 巨大な状態から叩きつける
        es = lerp(3.2, 1, easeOutCubic(p));
        ea = clamp(p * 3, 0, 1);
        break;
      case 'drop': // 上から落ちてバウンド
        ey = -(1 - easeOutBounce(p)) * H * toUnit;
        break;
      case 'slideL':
      case 'slideR': // 横から滑り込む
        ex = (k.entrance === 'slideL' ? -1 : 1) * (1 - easeOutExpo(p)) * W * toUnit;
        er = (1 - p) * 0.4 * (k.entrance === 'slideL' ? -1 : 1);
        break;
      case 'spin': // 回転しながら出る
        er = (1 - easeOutBack(p)) * Math.PI * 1.5 * k.dir;
        es = easeOutBack(p, 2);
        break;
      case 'zoom': // 点からポンと出る
        es = easeOutBack(p, 3.5);
        break;
      case 'rise': // 下から回転しながら浮かぶ
        ey = (1 - easeOutCubic(p)) * H * 0.8 * toUnit;
        er = (1 - p) * 0.8 * k.dir;
        break;
      case 'scatter': // 文字がバラバラの位置から集まる（文字ごとに下で処理）
        break;
    }
  }

  // ---- 常に動き続ける（ふわふわ・ビート） ----
  const amp = 0.5 + I * 1.6 + features.motion * 1.5;
  const idleY = Math.sin(t * 1.9 + k.phase) * U * 0.05 * amp;
  const idleX = Math.cos(t * 1.3 + k.phase) * U * 0.03 * amp;
  const idleR = Math.sin(t * 1.5 + k.phase) * 0.035 * amp;
  const isLast = c.live && k === c.chunks[c.chunks.length - 1];
  const beat = c.live ? 1 + features.volume * (isLast ? 0.28 : 0.1) : 1 + Math.max(0, Math.sin(now / 280 + k.phase)) * 0.025 * (0.5 + I);

  ctx.save();
  ctx.translate(k.x + ex + idleX, k.y + ey + idleY);
  const tiltAmt = c.mode === 'columns' || k.vertical ? 0.35 : 1;
  ctx.rotate(k.tilt * tiltAmt * (0.6 + I) + idleR + er);
  const s = k.s * es * beat;
  ctx.scale(s, s);
  ctx.globalAlpha = c.alpha * ea;
  ctx.font = k.font;

  const emo = c.emotion;
  const str = c.strength;
  const scary = cat === 'fear';
  k.chars.forEach((ch, i) => {
    const ct = (now - ch.born) / 1000;
    if (ct < 0) return;
    // 1 文字ずつポンと出る
    let sc = simple || ct >= 0.18 ? 1 : easeOutBack(ct / 0.18, 2 + I * 3);
    let dx = 0;
    let dy = 0;
    let rot = 0;
    if (!simple) {
      if (k.entrance === 'scatter' && p < 1) {
        const r = mulberry32(k.index * 97 + i * 13 + c.seed);
        const q = 1 - easeOutCubic(p);
        dx += (r() - 0.5) * W * toUnit * q;
        dy += (r() - 0.5) * H * toUnit * q;
        rot += (r() - 0.5) * 3 * q;
      }
      switch (emo) {
        case 'fear': // 全体がじわっと震える
          dx += jitter(U * 0.02 * (0.5 + str));
          dy += jitter(U * 0.02 * (0.5 + str));
          break;
        case 'surprise': // 跳ねて弾ける
          dy -= Math.abs(Math.sin(t * 9 + i * 0.5)) * U * 0.25 * Math.exp(-t * 1.2);
          sc *= 1 + 0.15 * Math.exp(-t * 2) * Math.sin(t * 22);
          break;
        case 'joy': // うねうね波打つ
          dy += Math.sin(now / 200 + i * 0.8 + k.index) * U * 0.09 * (0.5 + str);
          rot += Math.sin(now / 280 + i) * 0.14;
          break;
        case 'anger': // 小刻みに脈打つ
          dx += jitter(U * 0.035);
          dy += jitter(U * 0.035);
          sc *= 1 + 0.08 * Math.abs(Math.sin(now / 60));
          break;
        case 'sad': // ゆっくり沈む
          dy += (Math.sin(now / 700 + i * 0.6) * 0.5 + 0.5) * U * 0.06;
          break;
      }
      if (cat === 'sound') {
        // 擬音はリズムよく弾む
        dy -= Math.abs(Math.sin(now / 130 + i * 0.9)) * U * 0.12;
        rot += Math.sin(now / 150 + i) * 0.12;
      }
      // 怖い単語は感情の種類に関係なく激しく震える
      if (scary) {
        const a = U * 0.06 * (0.6 + str);
        dx += jitter(a);
        dy += jitter(a);
        rot += jitter(0.18);
      }
    }

    ctx.save();
    ctx.translate(ch.ox + dx, ch.oy + dy);
    if (k.vertical) {
      if (RE_V_ROTATE.test(ch.ch)) rot += Math.PI / 2;
      else if (RE_V_PUNCT.test(ch.ch)) ctx.translate(U * 0.32, -U * 0.32);
      else if (RE_V_SMALL.test(ch.ch)) ctx.translate(U * 0.1, -U * 0.1);
    }
    if (rot) ctx.rotate(rot);
    if (sc !== 1) ctx.scale(sc, sc);
    glyph(k, ch.ch, 0, 0, simple);
    ctx.restore();
  });
  ctx.restore();
}

function drawCaption(c, now) {
  if (!c.chunks.length || c.alpha < 0.01 || !c.scale) return;
  const I = c.live ? features.intensity : c.finalI;
  let extraS = 1;
  let extraR = 0;
  let simple = false;

  if (c.state !== 'main') {
    // 前の字幕は吹き飛ぶように大きくなり、背景に薄く残る
    const q = clamp((now - c.leftAt) / 450, 0, 1);
    const e = easeOutCubic(q);
    const drift = (now - c.leftAt) / 1000;
    extraS = 1 + e * 0.6 + drift * 0.015;
    extraR = e * 0.12 * (c.tailDir || 1) + drift * 0.004;
    const target = c.state === 'bg' ? c.alpha : lerp(1, 0.14, e);
    if (c.state === 'leaving') {
      c.alpha = Math.min(c.alpha, target);
      if (q >= 1) c.state = 'bg';
    }
    simple = q >= 1;
  }

  ctx.save();
  ctx.translate(c.cx, c.cy);
  ctx.rotate(c.tilt * (0.5 + I) + extraR);
  ctx.scale(c.scale * extraS, c.scale * extraS);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  if (c.bubble && c.state === 'main') drawBubble(c, now);
  ctx.globalAlpha = c.alpha;
  for (const k of c.chunks) drawChunk(c, k, now, I, simple);
  ctx.restore();
}

function drawParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * (dt / 16);
    p.y += p.vy * (dt / 16);
    p.vy += 0.35 * (dt / 16);
    p.vx *= 0.985;
    p.rot += p.vr;
    p.life -= p.decay;
    if (p.life <= 0 || p.y > H + 50) {
      particles.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life * 1.5);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    else if (p.shape === 'spark') {
      ctx.beginPath();
      ctx.moveTo(0, -p.size);
      ctx.lineTo(p.size * 0.2, 0);
      ctx.lineTo(0, p.size);
      ctx.lineTo(-p.size * 0.2, 0);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, p.size * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function render(now, dt) {
  const emotion = currentEmotion();
  const I = features.intensity;
  drawBackground(now, emotion, I);

  // カメラワーク: 常にゆっくり動き、単語が出るたびにドンと寄る
  // 寄りすぎると字幕が画面外に切れるので上限を設ける
  cam.punch = Math.min(cam.punch, 0.14) * 0.86;
  cam.rot = clamp(cam.rot, -0.05, 0.05) * 0.9;
  const zoom = 1 + cam.punch + Math.sin(now / 2300) * 0.025;
  const rot = cam.rot + Math.sin(now / 3700) * 0.012;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.rotate(rot);
  ctx.translate(-W / 2, -H / 2);
  if (fx.shake > 0.3) {
    ctx.translate(jitter(fx.shake), jitter(fx.shake));
    fx.shake *= 0.86;
  }

  // 衝撃波
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.r += r.speed * dt;
    r.a *= 0.93;
    if (r.a < 0.02) {
      rings.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = r.a;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 8 + 14 * r.a;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 背景に残った過去の字幕 → 今の字幕 の順に描く
  for (const c of captions) if (c.state !== 'main') drawCaption(c, now);
  for (const c of captions) if (c.state === 'main') drawCaption(c, now);
  drawParticles(dt);
  ctx.restore();

  // 下端の音量バー（聞いていることが分かるように）
  const color = liveCaption ? EMOTIONS[liveCaption.emotion].glow : '#6f8cff';
  const bw = W * features.volume;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.fillRect((W - bw) / 2, H - 4 - features.volume * 12, bw, 4 + features.volume * 12);
  ctx.globalAlpha = 1;
}

/* =========================================================
 * メインループ
 * ========================================================= */
let lastTime = performance.now();

function frame() {
  // rAF の引数ではなく performance.now() に揃える（イベント側の時刻と基準を一致させる）
  const now = performance.now();
  const dt = Math.min(50, now - lastTime);
  lastTime = now;

  updateAudio();
  updateBody(now);

  // 話速: 発話中の字幕の文字数 / 経過時間
  if (liveCaption && liveCaption.text) {
    const sec = Math.max(0.8, (now - liveCaption.born) / 1000);
    features.rate = lerp(features.rate, liveCaption.text.length / sec, 0.1);
  } else {
    features.rate = lerp(features.rate, 0, 0.02);
  }
  features.rateNorm = clamp((features.rate - 3) / 7, 0, 1);
  features.intensity = computeIntensity(features);
  features.recentPeak = Math.max(features.intensity, features.recentPeak - dt / 3000);

  // 大きな声のときは紙吹雪を少しずつ出し続ける
  if (liveCaption && features.intensity > 0.55 && Math.random() < features.intensity * 0.5) {
    burstParticles(rand(0, W), rand(H * 0.1, H * 0.9), 2, liveCaption.emotion);
  }

  for (const c of captions) c.update(now);
  for (let i = captions.length - 1; i >= 0; i--) {
    if (captions[i].dead && captions[i] !== liveCaption) captions.splice(i, 1);
  }

  render(now, dt);
  drawCamView();
  updateHud(now);
  requestAnimationFrame(frame);
}

/* =========================================================
 * 解析値表示（D キー）
 * ========================================================= */
let hudLast = 0;
function updateHud(now) {
  if (hud.hidden || now - hudLast < 100) return;
  hudLast = now;
  const emo = currentEmotion();
  const main = captions.find((c) => c.state === 'main');
  const words = main ? main.chunks.map((k) => `${k.text}<small>(${CATEGORIES[k.category].label}/${k.family})</small>`).join(' ') : '';
  const rows = [
    ['音量', features.volume, `${features.db.toFixed(0)}dB`],
    ['ピッチ', features.pitchExcite, `${features.pitch.toFixed(0)}Hz`],
    ['基準ピッチ', null, `${features.pitchBase.toFixed(0)}Hz`],
    ['話速', features.rateNorm, `${features.rate.toFixed(1)}字/s`],
    ['動き', features.motion, features.bodyDetected ? features.motion.toFixed(2) : '未検出'],
    ['手の広がり', features.spread, features.spread.toFixed(2)],
    ['手を挙げる', features.handsUp, features.handsUp.toFixed(2)],
    ['顔を覆う', features.handsFace, features.handsFace.toFixed(2)],
    ['強さ', features.intensity, features.intensity.toFixed(2)],
  ];
  hud.innerHTML =
    rows
      .map(
        ([label, v, text]) =>
          `<div class="row"><span class="label">${label}</span><span class="bar">${
            v === null ? '' : `<i style="width:${(v * 100).toFixed(0)}%"></i>`
          }</span><span class="val">${text}</span></div>`,
      )
      .join('') +
    `<div class="row"><span class="label">感情</span><span style="color:${EMOTIONS[emo].color}">${EMOTIONS[emo].label}</span></div>` +
    `<div class="row"><span class="label">認識</span><span>${running ? '● 聞き取り中' : '停止'}</span></div>` +
    (words ? `<div class="words">${words}</div>` : '');
}

/* =========================================================
 * 起動・キー操作
 * ========================================================= */
async function start() {
  startBtn.disabled = true;
  startBtn.textContent = '準備中…';
  // 字幕用フォントの読み込みを待つ（オフラインでも 3 秒で諦めて代替フォントで続行）
  const loads = Object.keys(FONT_FAMILIES).map((f) => document.fonts.load(fontSpec(f, 64), 'あア字!').catch(() => {}));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 3000))]);

  try {
    // 自動ゲイン等を切って、実際の声の大きさを取れるようにする
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    initAudio(stream);
    initRecognition();
  } catch (err) {
    console.error(err);
    toast('マイクを使えません。Enter キーで手入力モードとして使えます', 6000);
  }

  overlay.hidden = true;
  document.body.classList.add('running');
  requestAnimationFrame(frame);
  // カメラと MediaPipe の読み込みは時間がかかるので、声の字幕を先に動かしておく
  initBody();
}

startBtn.addEventListener('click', start);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast('F11 キーでフルスクリーンにしてください'));
}

window.addEventListener('keydown', (e) => {
  if (e.target === textInput) {
    if (e.key === 'Escape') {
      textForm.hidden = true;
      textInput.blur();
    }
    return;
  }
  if (!overlay.hidden) return;
  switch (e.key) {
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'd':
    case 'D':
      hud.hidden = !hud.hidden;
      break;
    case 'c':
    case 'C':
      captions.length = 0;
      liveCaption = null;
      break;
    case 'v':
    case 'V':
      if (body.landmarker) camView.hidden = !camView.hidden;
      break;
    case 'Enter':
      e.preventDefault();
      textForm.hidden = false;
      textInput.focus();
      break;
  }
});

textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (text) commitTyped(text);
  textInput.value = '';
});
