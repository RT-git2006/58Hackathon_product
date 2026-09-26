'use strict';

/* =========================================================
 * 激面白字幕メーカー
 *  - Web Speech API : 音声認識（#1）
 *  - Web Audio API  : 音量・ピッチ・話速の解析（#2）
 *  - MediaPipe Face : 表情（笑顔・しかめ面・真顔 など）と頭の動き（#3）
 *  - 声+表情の複合スコアで感情の種類・強さを推定（#4）
 *  - Canvas         : リリックビデオ風に動く字幕（#5）・感情で形が変わる吹き出し（#7）
 *  - フルスクリーン   : F キー / F11（#6）
 * 語彙・フォント・配色は lexicon.js
 * ========================================================= */

// ---------- 設定 ----------
const CONFIG = {
  lang: 'ja-JP',
  fallbackFont: "'Hiragino Sans', 'Meiryo', sans-serif",
  U: 100, // レイアウト計算の基準フォントサイズ(px)。描画時に画面に合わせて拡大する
  lineRatio: 0.075, // 字幕の基準の 1 文字の高さ（画面の高さ比）。大事な言葉・大きな声の言葉はこれより大きくなる
  textBottom: 0.9, // いちばん新しい字幕の下端の位置（画面の高さ比）。古い字幕は上へ押し出されていく
  fadeTop: 0.22, // 上へ押し出された字幕が、画面の上のこの範囲（高さ比）で薄くなって消える
  paraMaxChars: 40, // 1 つの吹き出しに入れる最大文字数（文の区切りでも吹き出しを分ける）
  exitDur: 380, // 字幕が消えるアニメーションの長さ(ms)
  dbFloor: -58, // この音量(dBFS)以下は無音扱い
  dbCeil: -12, // この音量で最大
  charStagger: 35, // 1 文字ずつ出てくる間隔(ms)。タイピングしているように見える
  enterDur: 280, // 単語の登場アニメーションの長さ(ms)
  pitchMin: 80,
  pitchMax: 600,
  faceInterval: 80, // 表情の認識の間隔(ms)。表情はそこまで速く変わらないので、描画を重くしないよう間引く
  faceGain: 1.6, // 表情の感度（大きいほど、少しの表情の変化でも反応する）
  faceMoodRate: 0.2, // 表情が会話の雰囲気（背景の色）に効く強さ
  moodHalfLife: 25000, // 会話の雰囲気（背景の色）が前の話題を引きずる時間の目安(ms)
  summaryHalfLife: 40000, // 中央の要約の絵文字が、前の話題を引きずる時間の目安(ms)
  summaryAlpha: 0.13, // 中央の要約の絵文字の濃さ
  showTopics: true, // 会話に出た話題の絵文字を背景に表示する（T キーで切替）
  topicLife: 120000, // 話題の絵文字が、最後に話に出てから消えるまで(ms)
  topicMax: 14, // 背景に出す話題の数の上限
  topicAlpha: 0.14, // 背景の絵文字の濃さ
  topicDrift: 0.0025, // 話題が左へ流れる速さ（画面幅/秒）。右が今の話題、左が少し前の話題
  mediapipeVersion: '0.10.14',
  faceModel: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};
const U = CONFIG.U;

// 感情ごとの演出（背景色・吹き出し）
const EMOTIONS = {
  neutral: { label: '平常', color: '#ffffff', glow: '#6f8cff', bubble: 'speech', fill: '#ffffff', line: '#111111' },
  joy: { label: '喜び', color: '#ffd23f', glow: '#ff9d00', bubble: 'cloud', fill: '#fff4b8', line: '#111111' },
  surprise: { label: '驚き', color: '#3fe0ff', glow: '#00a2ff', bubble: 'burst', fill: '#ffffff', line: '#111111' },
  fear: { label: '恐怖', color: '#c9a6ff', glow: '#8a2be2', bubble: 'wavy', fill: '#16001f', line: '#b98cff' },
  anger: { label: '怒り', color: '#ff4d4d', glow: '#ff2020', bubble: 'jagged', fill: '#ffe03a', line: '#111111' },
  sad: { label: '悲しみ', color: '#8fc4ff', glow: '#3d7bff', bubble: 'drip', fill: '#d8ecff', line: '#1d3b6e' },
};

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
  // 表情と頭の動き（MediaPipe Face Landmarker）
  faceDetected: false,
  motion: 0, // 0..1 頭の動きの速さ
  expr: { joy: 0, surprise: 0, anger: 0, sad: 0, fear: 0, neutral: 0 }, // 0..1 表情ごとの強さ（neutral＝真顔）
};

// 声と表情・頭の動きを 1 つの強さスコアに統合（#4）
// 声が主役。黙って表情を変えても字幕は出ないが、表情豊かに話すと強さが増幅される
function computeIntensity(f) {
  const voice = f.volume * 0.65 + f.pitchExcite * 0.2 + f.rateNorm * 0.15;
  const e = f.expr;
  const face = f.motion * 0.5 + Math.max(e.joy, e.surprise, e.anger, e.sad, e.fear) * 0.5;
  return clamp(voice * (1 + face * 0.8) + face * voice * 0.3, 0, 1);
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
 * MediaPipe Face Landmarker: 表情と頭の動き
 *   顔の筋肉の動き（ブレンドシェイプ 0..1）から 笑顔 / しかめ面 / 口角が下がる / 目を見開く などを取り、
 *   喜び・怒り・悲しみ・驚き・恐怖・真顔 のスコアにする。
 *   人によって普段の顔が違うので、その人の平常時の顔を基準（baseline）にして差分を見る
 * ========================================================= */
const video = document.getElementById('cam');
const camView = document.getElementById('camView');
const camCtx = camView.getContext('2d');
const face = { landmarker: null, lastVideoTime: -1, lastRun: 0, prev: null, prevTime: 0, lm: null, base: {} };

// 使うブレンドシェイプ（左右があるものは平均する）
const FACE_SHAPES = {
  smile: ['mouthSmileLeft', 'mouthSmileRight'],
  frown: ['mouthFrownLeft', 'mouthFrownRight'],
  browDown: ['browDownLeft', 'browDownRight'],
  browInnerUp: ['browInnerUp'],
  browOuterUp: ['browOuterUpLeft', 'browOuterUpRight'],
  eyeWide: ['eyeWideLeft', 'eyeWideRight'],
  sneer: ['noseSneerLeft', 'noseSneerRight'],
  press: ['mouthPressLeft', 'mouthPressRight'],
  stretch: ['mouthStretchLeft', 'mouthStretchRight'],
};
// プレビューに描く顔の輪郭（顔の外周の点）
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149,
  150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10];
const EXPRESSION_LABEL = { joy: '笑顔', surprise: '驚き顔', anger: 'しかめ面', sad: '悲しい顔', fear: 'こわばり', neutral: '真顔' };

async function initFace() {
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
    toast('表情の認識を準備中…', 10000);
    const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CONFIG.mediapipeVersion}`;
    // classic script から ES モジュールを動的 import（ビルド不要のまま使うため）
    const { FilesetResolver, FaceLandmarker } = await import(`${base}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
    const create = (delegate) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: CONFIG.faceModel, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
    // GPU が使えない PC では CPU にフォールバック
    face.landmarker = await create('GPU').catch(() => create('CPU'));
    camView.width = 320;
    camView.height = 240;
    toast('表情の認識 ON（V キーでカメラ表示）');
  } catch (err) {
    console.error(err);
    toast('表情の認識を読み込めませんでした（声だけで動作します）', 5000);
  }
}

// 平常時の顔からどれだけ動いたか（0..1）。基準は、下がるときは速く・上がるときはゆっくり追従させる
function faceDelta(name, v) {
  const b = face.base[name] ?? v;
  face.base[name] = lerp(b, v, v < b ? 0.05 : 0.002);
  return clamp(((v - face.base[name]) / Math.max(0.15, 1 - face.base[name])) * CONFIG.faceGain, 0, 1);
}

function updateFace(now) {
  if (!face.landmarker || video.readyState < 2 || video.currentTime === face.lastVideoTime) return;
  if (now - face.lastRun < CONFIG.faceInterval) return;
  face.lastRun = now;
  face.lastVideoTime = video.currentTime;
  const res = face.landmarker.detectForVideo(video, now);
  const lm = res.faceLandmarks && res.faceLandmarks[0];
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  face.lm = lm || null;
  const f = features;

  if (!lm || !cats) {
    f.faceDetected = false;
    f.motion = lerp(f.motion, 0, 0.2);
    for (const k in f.expr) f.expr[k] = lerp(f.expr[k], 0, 0.2);
    face.prev = null;
    return;
  }
  f.faceDetected = true;

  // ブレンドシェイプ → 平常時からの差分
  const score = {};
  for (const c of cats) score[c.categoryName] = c.score;
  const d = {};
  for (const [name, keys] of Object.entries(FACE_SHAPES)) {
    const v = keys.reduce((a, k) => a + (score[k] || 0), 0) / keys.length;
    d[name] = faceDelta(name, v);
  }
  const browUp = Math.max(d.browInnerUp, d.browOuterUp);

  // 表情 → 感情のスコア
  const target = {
    joy: d.smile * 1.3,
    surprise: d.eyeWide * 0.8 + browUp * 0.5 * (0.5 + d.eyeWide),
    anger: (d.browDown * 0.9 + d.sneer * 0.6 + d.press * 0.3) * (1 - d.smile),
    sad: (d.frown * 0.8 + d.browInnerUp * 0.5 * (1 - d.eyeWide)) * (1 - d.smile),
    fear: d.eyeWide * browUp * 1.2 + d.stretch * 0.5,
  };
  let strongest = 0;
  for (const k in target) {
    target[k] = clamp(target[k], 0, 1);
    strongest = Math.max(strongest, target[k]);
    f.expr[k] = lerp(f.expr[k], target[k], 0.35);
  }
  f.expr.neutral = lerp(f.expr.neutral, clamp(1 - strongest * 2, 0, 1), 0.2); // 真顔

  // 頭の動きの速さ（顔の幅/秒）: うなずき・首振り・身を乗り出す
  const nose = lm[1];
  const width = Math.max(0.05, Math.hypot(lm[454].x - lm[234].x, lm[454].y - lm[234].y));
  let raw = 0;
  if (face.prev) {
    const dtSec = Math.max(0.016, (now - face.prevTime) / 1000);
    raw = clamp(Math.hypot(nose.x - face.prev.x, nose.y - face.prev.y) / width / dtSec / 2.5, 0, 1);
  }
  // 大きく動いた瞬間はすぐ反映し、ゆっくり落ち着く
  f.motion = lerp(f.motion, raw, raw > f.motion ? 0.7 : 0.1);
  face.prev = { x: nose.x, y: nose.y };
  face.prevTime = now;
}

// いちばん強い表情（真顔を含む）
function currentExpression() {
  let best = 'neutral';
  let bestV = 0.25;
  for (const [k, v] of Object.entries(features.expr)) {
    if (k !== 'neutral' && v > bestV) {
      best = k;
      bestV = v;
    }
  }
  return best;
}

// 右下のカメラプレビュー（鏡像＋顔の輪郭＋今の表情）
function drawCamView() {
  if (camView.hidden || !face.landmarker) return;
  const w = camView.width;
  const h = camView.height;
  camCtx.save();
  camCtx.translate(w, 0);
  camCtx.scale(-1, 1);
  camCtx.globalAlpha = 0.6;
  camCtx.drawImage(video, 0, 0, w, h);
  camCtx.globalAlpha = 1;
  const lm = face.lm;
  const expr = currentExpression();
  const color = EMOTIONS[expr].color;
  if (lm) {
    camCtx.strokeStyle = color;
    camCtx.lineWidth = 3;
    camCtx.beginPath();
    FACE_OVAL.forEach((id, i) => (i ? camCtx.lineTo(lm[id].x * w, lm[id].y * h) : camCtx.moveTo(lm[id].x * w, lm[id].y * h)));
    camCtx.stroke();
  }
  camCtx.restore();
  if (lm) {
    camCtx.font = 'bold 18px sans-serif';
    camCtx.fillStyle = color;
    camCtx.fillText(EXPRESSION_LABEL[expr], 10, 24);
  }
}

// 表情も会話の雰囲気（背景の色）に少しずつ効かせる。聞いている人の表情も場の空気の一部
function feedFaceAtmosphere(dt) {
  if (!features.faceDetected) return;
  const e = features.expr;
  const k = (dt / 1000) * CONFIG.faceMoodRate;
  atmosphere.score.happy += e.joy * k;
  atmosphere.score.excited += e.surprise * k;
  atmosphere.score.sad += e.sad * k;
  atmosphere.score.angry += e.anger * k;
  atmosphere.score.fear += e.fear * k;
  // 真顔でしゃべり続けていると、シリアス寄りに
  if (features.volume > 0.1) atmosphere.score.serious += e.neutral * k * 0.6;
}

/* =========================================================
 * テキスト解析・感情推定
 * ========================================================= */
// 単語分割はブラウザ内蔵の辞書（Intl.Segmenter）を使い、助詞などの短いひらがなは前の単語にくっつけて文節っぽくする
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
const RE_HIRA = /^[ぁ-ゟー]+$/;
const RE_KANJI_END = /[一-鿿々]$/;
const RE_KANJI_START = /^[一-鿿々]/;
const RE_SENT_END = /[。！？!?]$/;
// 方言・話し言葉の文末（前の単語にくっつける）
//   関西: やねん へん やん やで さかい はる / 博多: ったい けん ばい やけん / 広島: じゃけえ じゃろ けえ
//   名古屋: だがや でかん みゃあ / 東北・北海道: だべ べさ だっちゃ っしょ したっけ / 沖縄: さー やっさ / 土佐: ぜよ やき
const RE_DIALECT_END = new RegExp(
  '^(' +
    [
      'やねん', 'ねん', 'やんか', 'やんな', 'やん', 'へん', 'ひん', 'へんで', 'まへん', 'やで', 'やわ', 'やな', 'やろ', 'やし',
      'けど', 'けどな', 'さかい', 'がな', 'ねや', 'んや', 'んか', 'とる', 'とん', 'てん', 'たん', 'はる', 'よる', 'やんけ',
      'ったい', 'けん', 'ばい', 'やけん', 'やけ', 'っちゃ', 'とよ', 'じゃけえ', 'じゃけん', 'じゃろ', 'じゃのう', 'けえ',
      'だがや', 'がや', 'でかん', 'みゃあ', 'だぎゃ', 'だべ', 'だべさ', 'べさ', 'だっちゃ', 'んだ', 'だす', 'っしょ', 'したっけ',
      'さー', 'やっさ', 'ぜよ', 'やき', 'じゃき', 'どす', 'じゃん', 'ちゃう', 'っす', 'みたいな',
    ].join('|') +
    ')$',
);
// 強調の言葉（標準語・各地の方言・若者言葉）。含む単語は大きくする
const RE_INTENSIFIER =
  /めっちゃ|めっさ|むっちゃ|めちゃ|ごっつ|えらい|ほんま|ホンマ|すっご|超|クソ|くっそ|バリ|ばり|ぶち|でら|なまら|でーじ|ちかっぱ|がばい|わや|鬼|激|爆|ガチ|マジで/;
const MAX_CHUNK = 8;

const normalize = (text) => text.replace(/\s+/g, '');

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
    const t = normalize(s.t);
    if (!t) continue;
    const prev = out[out.length - 1];
    const attach =
      prev !== undefined &&
      prev.length + t.length <= MAX_CHUNK + 2 &&
      (!s.word || // 句読点・記号
        (RE_HIRA.test(t) && (t.length <= 2 || prev.length === 1)) || // 助詞・送り仮名
        RE_DIALECT_END.test(t) || // 方言・話し言葉の文末
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

// 声と表情から推定した感情スコア（キーワードが無くても反応させる）
function prosodyScores(f) {
  const e = f.expr;
  return {
    // 声が裏返る／目を見開く → 驚き
    surprise: f.pitchExcite * f.volume * 1.2 + e.surprise * 0.9,
    // 低めの大声／しかめ面 → 怒り
    anger: (f.volume > 0.7 && f.pitchExcite < 0.25 ? (f.volume - 0.7) * 3 : 0) + e.anger * 0.9,
    // 声が高く弾む／笑顔 → 喜び
    joy: f.pitchExcite * f.rateNorm * 0.8 + e.joy * 1.0,
    // 小声で早口／こわばった顔 → 恐怖
    fear: (f.volume < 0.25 && f.rateNorm > 0.5 ? 0.4 : 0) + e.fear * 0.9,
    // 小声でゆっくり・低い／口角が下がる → 悲しみ
    sad: (f.volume > 0.05 && f.volume < 0.3 && f.rateNorm < 0.2 && f.pitchExcite < 0.1 ? 0.3 : 0) + e.sad * 0.9,
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
 * 動きの種類（単語の内容＝ムードで選ぶ）
 * ========================================================= */
// 単語のカテゴリ → ムード
const MOOD_OF = {
  joy: 'happy', love: 'happy', funny: 'happy', food: 'happy', sound: 'happy',
  sad: 'sad', fear: 'fear', anger: 'angry', power: 'angry', surprise: 'surprise',
  cool: 'cool', tech: 'cool', nature: 'calm', katakana: 'calm', neutral: 'calm',
};
// 発話全体の感情 → ムード（内容の無い単語は、発話全体の雰囲気に合わせる）
const EMO_MOOD = { joy: 'happy', sad: 'sad', fear: 'fear', anger: 'angry', surprise: 'surprise', neutral: 'calm' };
// 発話全体の感情 → 内容の無い単語に使う配色
const EMO_CAT = { joy: 'joy', sad: 'sad', fear: 'fear', anger: 'anger', surprise: 'surprise' };

// ムードごとの登場アニメーション候補（単語ごとに、前の単語と被らないように選ぶ）
const MOOD_ENTRANCES = {
  happy: ['bounce', 'pop', 'jump', 'waveIn', 'spin', 'swing', 'balloon'],
  sad: ['fallSlow', 'drip', 'fadeDown', 'sink'],
  fear: ['glitchIn', 'creep', 'flicker', 'shakeIn'],
  angry: ['slam', 'stomp', 'crash', 'shakeIn'],
  surprise: ['pop', 'slam', 'flipX', 'burst', 'jump'],
  cool: ['slideL', 'slideR', 'wipe', 'flipY', 'typewriter', 'scramble'],
  calm: ['fadeUp', 'typewriter', 'slideL', 'slideR', 'flipX', 'waveIn', 'zoom', 'wipe', 'drop'],
};
// 登場にかかる時間(ms)と、文字ごとの出現間隔(ms)
const ENTRANCE_TIME = { fallSlow: 700, drip: 650, fadeDown: 600, sink: 650, creep: 700, flicker: 500, typewriter: 300, scramble: 450 };
const ENTRANCE_STAGGER = { typewriter: 55, scramble: 45, wipe: 30, drip: 60, jump: 35, waveIn: 30, glitchIn: 30 };
// 文字ごとに動く登場アニメーション
const CHAR_ENTRANCES = new Set(['jump', 'waveIn', 'drip', 'typewriter', 'wipe', 'scramble', 'glitchIn']);
const SCRAMBLE_POOL = 'アイウエオカキクケコサシスセソ01#$%&@*?';

/* =========================================================
 * 字幕: 単語（Chunk）と吹き出し（Caption）
 *   文字起こしのように、1 つの Caption（吹き出し 1 つ）の中で単語が左から右へ打ち込まれ、行を折り返す。
 *   新しい吹き出しは画面の下に出て、古い吹き出しは上へ押し出されていく。
 *   文の区切りや、文字数が多くなった所で、次の吹き出しに進む
 * ========================================================= */
const EMOJI_FONT = `${U}px 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif`;
const EMOJI_SIZE = 0.95; // 絵文字の幅（基準単位 U 比）

// カラー絵文字は、描く大きさが変わるたびに画像を作り直すため非常に重い（大きいと 1 回 100ms 以上）。
// 絵文字ごとに 1 回だけ固定サイズの画像に描いておき、以後はその画像を拡大縮小して貼る（GPU で処理されて軽い）
const EMOJI_SPRITE_FONT = 256; // 画像に描くときの文字サイズ(px)
const EMOJI_SPRITE = 320; // 画像の一辺(px)。絵文字がはみ出さないよう文字サイズより少し大きく
const emojiSprites = new Map();

function emojiSprite(emoji) {
  let c = emojiSprites.get(emoji);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = EMOJI_SPRITE;
    const g = c.getContext('2d');
    g.font = EMOJI_FONT.replace(`${U}px`, `${EMOJI_SPRITE_FONT}px`);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(emoji, EMOJI_SPRITE / 2, EMOJI_SPRITE / 2);
    emojiSprites.set(emoji, c);
  }
  return c;
}

// 今の座標系の原点を中心に、文字サイズ U 相当の大きさで絵文字を描く（fillText(emoji, 0, 0) の代わり）
function drawEmoji(emoji) {
  const d = (EMOJI_SPRITE * U) / EMOJI_SPRITE_FONT;
  ctx.drawImage(emojiSprite(emoji), -d / 2, -d / 2, d, d);
}

class Chunk {
  constructor(cap, index, text, now) {
    this.cap = cap;
    this.index = index;
    const r = mulberry32(cap.seed * 131 + index * 7919);
    this.roll = { font: r(), pal: r(), style: r(), size: r(), enter: r() };
    this.dir = r() < 0.5 ? -1 : 1;
    this.tilt = (r() - 0.5) * 0.04; // 文字起こしとして読みやすいよう、傾きはわずかに
    this.phase = r() * Math.PI * 2;
    this.born = now;
    this.vol = cap.volOverride ?? Math.max(features.intensity, features.recentPeak * 0.7);
    this.chars = [];
    this.text = '';
    this.emoji = '';
    this.emojiBorn = 0;
    this.x = null; // レイアウト上の現在位置（基準単位、ページの中心が原点）
    this.y = 0;
    this.s = 1;
    // 登場の動きは最初の単語の内容で決める（途中で認識が書き換わっても変えない）
    const mood = this.moodFor(classifyChunk(text));
    const list = MOOD_ENTRANCES[mood];
    const prev = cap.chunks[index - 1];
    let e = pickBy(list, this.roll.enter);
    if (prev && prev.entrance === e) e = list[(list.indexOf(e) + 1) % list.length];
    this.entrance = e;
    this.enterTime = ENTRANCE_TIME[e] || CONFIG.enterDur;
    this.stagger = ENTRANCE_STAGGER[e] || CONFIG.charStagger;
    this.setText(text, now);
  }

  moodFor(category) {
    const m = MOOD_OF[category];
    return m === 'calm' ? EMO_MOOD[this.cap.emotion] || 'calm' : m;
  }

  get mood() {
    return this.moodFor(this.category);
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
        delay += this.stagger;
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
    const emoji = findEmoji(text);
    if (emoji !== this.emoji) {
      this.emoji = emoji;
      this.emojiBorn = now + delay + 60;
    }
    this.measured = false;
    // Web フォントは文字種ごとに分割配信されるので、使う文字を先読みし、読めたら測り直す
    document.fonts
      .load(fontSpec(this.family, 64), text)
      .then(() => {
        this.measured = false;
      })
      .catch(() => {});
  }

  // 配色: 内容のある単語はそのカテゴリの色、内容の無い単語は発話全体の感情の色
  get palette() {
    const look = this.category === 'neutral' && EMO_CAT[this.cap.emotion] ? EMO_CAT[this.cap.emotion] : this.category;
    const p = CATEGORIES[look].palettes;
    return p[this.palIndex % p.length];
  }

  measure() {
    if (this.measured) return;
    ctx.font = this.font;
    for (const c of this.chars) c.w = ctx.measureText(c.ch).width;
    this.measured = true;
  }

  // 大きさの重み: 内容のある単語・叫んだ単語ほど大きい（文字起こしとして読める範囲に収める）
  weight() {
    let s = 0.9 + this.roll.size * 0.15;
    if (this.category !== 'neutral') s *= 1.25;
    if (/[!！]/.test(this.text)) s *= 1.1;
    if (RE_INTENSIFIER.test(this.text)) s *= 1.25;
    return clamp(s * (0.8 + this.vol * 0.6), 0.8, 1.9);
  }

  // 基準単位での大きさと、文字・絵文字ごとの位置（絵文字は単語の後ろに置く）
  box() {
    this.measure();
    const extra = this.emoji ? U * EMOJI_SIZE : 0;
    let off = 0;
    const total = this.chars.reduce((a, c) => a + c.w, 0) + extra;
    for (const c of this.chars) {
      c.ox = -total / 2 + off + c.w / 2;
      c.oy = 0;
      off += c.w;
    }
    this.ex = total / 2 - extra / 2;
    this.ey = 0;
    return { w: total, h: U * 1.15 };
  }
}

class Caption {
  constructor(now) {
    this.seed = Math.floor(Math.random() * 1e9);
    this.born = now;
    this.text = '';
    this.chunks = [];
    this.live = true;
    this.committedAt = 0;
    this.state = 'main'; // main（表示中）→ leaving（消えるアニメーション）→ 消える
    this.leftAt = 0;
    this.peak = features.recentPeak;
    this.finalI = 0;
    this.volOverride = null;
    this.prosody = { joy: 0, surprise: 0, fear: 0, anger: 0, sad: 0 };
    this.kw = {};
    this.emotion = 'neutral';
    this.strength = 0;
    this.scale = 0; // 基準単位 → 画面 px の倍率
    this.bw = 0; // 文字の範囲の大きさ（基準単位）
    this.bh = 0;
    this.left = 0; // 文字の範囲の左上（画面 px）
    this.top = null;
    this.targetTop = 0;
    this.outerH = 0; // 吹き出しを含めた高さ（画面 px）
    this.cx = W / 2; // 吹き出しの中心（画面 px。パーティクルの発生位置に使う）
    this.cy = H / 2;
    this.alpha = 1;
    this.dead = false;
  }

  setText(text, now) {
    this.text = text;
    const parts = splitChunks(text);
    for (let i = 0; i < parts.length; i++) {
      if (this.chunks[i]) this.chunks[i].setText(parts[i], now);
      else {
        // 前の単語を打ち終わってから次の単語を打ち始める（タイピングのように 1 文字ずつ）
        const prev = this.chunks[i - 1];
        const after = prev ? Math.max(now, prev.chars[prev.chars.length - 1].born + prev.stagger) : now;
        this.chunks.push(new Chunk(this, i, parts[i], after));
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
    const emo = pickEmotion(this.kw, this.prosody);
    this.emotion = emo.type;
    this.strength = emo.strength;
  }

  commit(now) {
    this.live = false;
    this.committedAt = now;
    this.finalI = clamp(this.peak * 0.8 + 0.1, 0, 1);
    const emo = pickEmotion(this.kw, this.prosody);
    this.emotion = emo.type;
    this.strength = emo.strength;
    if (this.finalI > 0.65 || this.strength > 0.6) impact(this);
    // 確定した吹き出しのキーワードの絵文字を、背景の「話題」に加え、会話の雰囲気にも反映する
    for (const k of this.chunks) if (k.emoji) addTopic(k.emoji, now);
    feedAtmosphere(this);
  }

  leave(now) {
    if (this.state === 'leaving') return;
    this.state = 'leaving';
    this.leftAt = now;
  }

  // この吹き出しに収まらなくなったら、先頭から何単語をこの吹き出しに残すかを返す（0 なら収まっている）
  breakPoint() {
    const n = this.chunks.length;
    if (n < 2) return 0;
    // 文の区切り（。！？）が途中にあれば、そこで吹き出しを分ける
    for (let i = 0; i < n - 1; i++) if (RE_SENT_END.test(this.chunks[i].text)) return i + 1;
    let chars = 0;
    for (let i = 0; i < n; i++) {
      chars += this.chunks[i].text.length;
      if (chars > CONFIG.paraMaxChars) return Math.max(1, i);
    }
    return 0;
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
    }
    if (this.state === 'leaving' && now - this.leftAt > CONFIG.exitDur) this.dead = true;

    this.layout();
    // 上へ押し出される動きは滑らかに
    this.top = this.top === null ? this.targetTop : lerp(this.top, this.targetTop, 0.16);
    this.cx = this.left + (this.bw / 2) * this.scale;
    this.cy = this.top + this.outerH / 2;

    // 単語を目標位置へ滑らかに動かす（行の折り返しもアニメーションになる）
    for (const k of this.chunks) {
      if (k.tx === undefined) continue;
      if (k.x === null) {
        k.x = k.tx;
        k.y = k.ty;
        k.s = k.ts;
      }
      k.x = lerp(k.x, k.tx, 0.22);
      k.y = lerp(k.y, k.ty, 0.22);
      k.s = lerp(k.s, k.ts, 0.22);
    }
  }

  // 吹き出しの横・縦の半径（基準単位）。角まで文字を覆うよう、文字の範囲より少し大きく
  bubbleSize() {
    return { a: (this.bw / 2) * BUBBLE_COVER + BUBBLE_PAD, b: (this.bh / 2) * BUBBLE_COVER + BUBBLE_PAD };
  }

  // 単語を左から右へ並べ、画面の幅で行を折り返す（文字起こしのように左揃え）
  layout() {
    if (!this.chunks.length) return;
    this.scale = (H * CONFIG.lineRatio) / U;
    // 吹き出しの幅が画面の 94% に収まる、文字の範囲の最大幅
    const limit = ((W * 0.94) / this.scale - BUBBLE_PAD * 2) / BUBBLE_COVER;
    const gap = U * 0.12;
    const lines = [];
    let line = { items: [], len: 0, h: 0 };
    for (const k of this.chunks) {
      const b = k.box();
      const s = k.weight();
      const it = { k, s, w: b.w * s, h: b.h * s };
      if (line.items.length && line.len + gap + it.w > limit) {
        lines.push(line);
        line = { items: [], len: 0, h: 0 };
      }
      line.len += (line.items.length ? gap : 0) + it.w;
      line.h = Math.max(line.h, it.h);
      line.items.push(it);
    }
    lines.push(line);
    // 単語の下端を行ごとに揃える（大きい単語は上に伸びる）
    let y = 0;
    for (const l of lines) {
      let x = 0;
      for (const it of l.items) {
        it.k.tx = x + it.w / 2;
        it.k.ty = y + l.h - it.h / 2;
        it.k.ts = it.s;
        it.k.w = it.w / it.s;
        x += it.w + gap;
      }
      y += l.h + gap * 0.6;
    }
    this.bw = Math.max(...lines.map((l) => l.len));
    this.bh = y - gap * 0.6;
    const { a, b } = this.bubbleSize();
    // 文字の左端は固定（吹き出しが横に伸びても、文字は動かない）
    this.left = W * 0.03 + (limit * (BUBBLE_COVER - 1) * 0.5 + BUBBLE_PAD) * this.scale;
    // 吹き出しのトゲ・しっぽの分も含めた高さ
    this.outerH = (b * 2 + U * 0.9) * this.scale;
    this.textTop = (b - this.bh / 2 + U * 0.25) * this.scale; // 吹き出しの上端から文字の上端まで(px)
    this.bubbleA = a;
    this.bubbleB = b;
  }
}

const BUBBLE_COVER = 1.12; // 吹き出しの輪郭が、文字の範囲の四隅まで覆うための倍率
const BUBBLE_PAD = U * 0.3; // 吹き出しの内側の余白（基準単位）

/* =========================================================
 * 字幕の管理（発話 → 吹き出し → 上へ流れる）
 * ========================================================= */
const captions = [];
let liveCaption = null; // 今しゃべっている内容を出している吹き出し
const utter = { start: 0, text: '' }; // 発話全体のテキストと、今の吹き出しが始まる文字位置
let pendingVol = null; // 手入力のときの強さ
const particles = [];
const fx = { shake: 0, flashColor: '#000', flash: 0 };
const cam = { punch: 0, rot: 0 };

// 新しい吹き出しを画面の下に置き、古い吹き出しを上へ積み上げる。画面の上に出たものは消す
function arrangeTranscript(now) {
  let bottom = H * CONFIG.textBottom;
  for (let i = captions.length - 1; i >= 0; i--) {
    const c = captions[i];
    if (!c.chunks.length) continue;
    c.targetTop = bottom - c.outerH;
    bottom = c.targetTop - H * 0.01;
    if (c.top !== null && c.top + c.outerH < 0) c.dead = true;
  }
  // 画面の上の方に来た吹き出しは薄くなる
  for (const c of captions) {
    if (c.top === null) continue;
    const q = clamp((c.top + c.outerH * 0.6) / (H * CONFIG.fadeTop), 0, 1);
    c.fade = q;
  }
}

function newCaption(now) {
  const c = new Caption(now);
  c.volOverride = pendingVol;
  captions.push(c);
  return c;
}

// 単語が増えるたびに画面が少し寄る
function onNewChunk() {
  const I = features.intensity;
  cam.punch += 0.004 + I * 0.01;
  if (I > 0.7) fx.shake = Math.max(fx.shake, I * 4);
}

// 大きな声・強い感情で確定したときの演出（控えめに）
function impact(c) {
  const emo = EMOTIONS[c.emotion];
  fx.shake = Math.max(fx.shake, 3 + c.finalI * 6);
  fx.flash = Math.max(fx.flash, 0.05 + 0.1 * c.finalI);
  fx.flashColor = emo.glow;
  cam.punch += 0.01 + 0.01 * c.finalI;
  if (c.finalI > 0.6) burstParticles(c.cx, c.cy, 24, c.emotion);
}

function burstParticles(x, y, n, emotion) {
  const colors = {
    joy: ['#ffd23f', '#ff4d8d', '#3fe0ff', '#7dff6a', '#ff9d00'],
    surprise: ['#00a2ff', '#3fe0ff', '#ffb300'],
    fear: ['#8a2be2', '#ff0044'],
    anger: ['#ff2020', '#ffb000', '#b3001b'],
    sad: ['#3d7bff', '#8fc4ff'],
    neutral: ['#6f8cff', '#ffd23f', '#3fe0ff', '#ff4d8d'],
  }[emotion];
  for (let i = 0; i < n && particles.length < 200; i++) {
    const a = rand(0, Math.PI * 2);
    const sp = rand(4, 14);
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - (emotion === 'sad' ? -2 : 3),
      rot: rand(0, 6),
      vr: jitter(0.3),
      size: rand(8, 18),
      color: colors[i % colors.length],
      life: 1,
      decay: rand(0.012, 0.025),
      shape: emotion === 'sad' ? 'drop' : emotion === 'anger' || emotion === 'surprise' ? 'spark' : 'rect',
    });
  }
}

// 今の吹き出しに収まらなくなったら、吹き出しを確定して続きを次の吹き出しへ送る
function paginate(text, now) {
  for (let guard = 0; guard < 10; guard++) {
    const keep = liveCaption.breakPoint();
    if (!keep) return;
    const kept = liveCaption.chunks
      .slice(0, keep)
      .map((k) => k.text)
      .join('');
    liveCaption.setText(kept, now);
    liveCaption.commit(now);
    utter.start += kept.length;
    liveCaption = newCaption(now);
    liveCaption.setText(text.slice(utter.start), now);
  }
}

// 認識途中のテキスト（発話の頭からの全文が毎回届く）
function updateLive(raw) {
  const now = performance.now();
  const text = normalize(raw);
  if (!text) return;
  if (!liveCaption) {
    liveCaption = newCaption(now);
    utter.start = 0;
  }
  utter.text = text;
  // 認識の書き換えで全文が短くなった場合
  utter.start = Math.min(utter.start, text.length);
  liveCaption.setText(text.slice(utter.start), now);
  paginate(text, now);
}

// 認識が確定したテキスト
function commitUtterance(raw) {
  const now = performance.now();
  const text = normalize(raw);
  if (!liveCaption) {
    if (!text) return;
    liveCaption = newCaption(now);
    utter.start = 0;
  }
  utter.start = Math.min(utter.start, text.length);
  const rest = text.slice(utter.start);
  if (rest) {
    liveCaption.setText(rest, now);
    paginate(text, now);
  }
  if (liveCaption.chunks.length) liveCaption.commit(now);
  else liveCaption.dead = true;
  liveCaption = null;
  utter.start = 0;
  utter.text = '';
}

// 手入力（音声認識が使えない時の代替）。「!」の数で強さを決める
function commitTyped(text) {
  if (liveCaption) commitUtterance(utter.text);
  pendingVol = clamp(0.35 + (text.match(/[!！]/g) || []).length * 0.2, 0, 1);
  features.recentPeak = Math.max(features.recentPeak, pendingVol);
  commitUtterance(text);
  pendingVol = null;
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
  // 新しい Chrome の「認識のヒント」（contextual biasing）があれば、辞書の単語を渡して認識されやすくする
  if ('phrases' in recognition && typeof SpeechRecognitionPhrase !== 'undefined') {
    try {
      recognition.phrases = HINT_WORDS.slice(0, 500).map((w) => new SpeechRecognitionPhrase(w, 3));
    } catch (err) {
      console.warn('認識のヒントは使えません', err);
    }
  }

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
    if (e.error === 'phrases-not-supported') {
      // この環境ではヒントが使えない → 外して普通に認識する
      recognition.phrases = [];
      return;
    }
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
    // 確定されないまま途切れた発話は、その時点のテキストで確定させる
    if (liveCaption) commitUtterance(utter.text);
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
 * 描画: 背景（白がベース。話の内容・表情・声で色が変わる）
 * ========================================================= */
const bgState = { base: [255, 255, 255], blobs: [hexToRgb('#7cc4ff'), hexToRgb('#8fe3c8'), hexToRgb('#b9a8ff')], speed: 0 };
let speedLines = [];
let speedLinesAt = 0;

// 今の感情: しゃべっている最中の吹き出し、なければ最後の吹き出し
function currentEmotion() {
  const c = liveCaption || captions[captions.length - 1];
  return c ? c.emotion : 'neutral';
}

/* =========================================================
 * 背景の話題（会話に出たキーワードの絵文字）
 *   新しい話題は右側に現れ、ゆっくり左へ流れていく（右＝今、左＝少し前）。
 *   同じ話題がまた出ると大きくなって右へ戻る → よく出る話題ほど大きく、長く残る
 * ========================================================= */
const topics = []; // { emoji, weight, born, last, x, y, phase, pulse }

function addTopic(emoji, now) {
  const t = topics.find((o) => o.emoji === emoji);
  if (t) {
    t.recent += 1;
    t.weight = Math.min(t.weight + 1, 6);
    t.last = now;
    t.pulse = 1;
    t.x = Math.min(0.9, t.x + 0.15);
    return;
  }
  // 既存の話題となるべく離れた位置（右寄り）に置く
  let best = null;
  let bestD = -1;
  for (let i = 0; i < 24; i++) {
    const x = rand(0.62, 0.92);
    const y = rand(0.12, 0.88);
    const d = Math.min(1, ...topics.map((o) => Math.hypot((o.x - x) * (W / H), o.y - y)));
    if (d > bestD) {
      bestD = d;
      best = { x, y };
    }
  }
  topics.push({ emoji, weight: 1, recent: 1, born: now, last: now, x: best.x, y: best.y, phase: rand(0, Math.PI * 2), pulse: 1 });
  // 多すぎたら、あまり話に出ていない・古い話題から消す
  if (topics.length > CONFIG.topicMax) {
    const score = (o) => o.weight - (now - o.last) / 30000;
    topics.splice(topics.indexOf(topics.reduce((a, b) => (score(a) < score(b) ? a : b))), 1);
  }
}

function drawTopics(now, dt) {
  if (!CONFIG.showTopics) return;
  ctx.save();
  for (let i = topics.length - 1; i >= 0; i--) {
    const t = topics[i];
    const fade = 1 - (now - t.last) / CONFIG.topicLife;
    if (fade <= 0) {
      topics.splice(i, 1);
      continue;
    }
    t.x = Math.max(0.06, t.x - (CONFIG.topicDrift * dt) / 1000);
    t.pulse *= 0.96;
    if (t.emoji === summary.cur) continue;
    const intro = clamp((now - t.born) / 1200, 0, 1);
    const size = H * (0.1 + 0.045 * t.weight) * (1 + t.pulse * 0.25) * easeOutCubic(intro);
    const x = t.x * W + Math.sin(now / 9000 + t.phase) * W * 0.02;
    const y = t.y * H + Math.cos(now / 11000 + t.phase) * H * 0.025;
    ctx.globalAlpha = CONFIG.topicAlpha * Math.min(1, fade * 3) * (0.7 + 0.08 * t.weight) * intro;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(now / 7000 + t.phase) * 0.12);
    ctx.scale(size / U, size / U);
    drawEmoji(t.emoji);
    ctx.restore();
  }
  ctx.restore();
}

/* =========================================================
 * 会話の雰囲気（背景の色）
 *   確定したページの単語のムードと、声から推定した感情を積み上げ、時間とともに薄れさせる。
 *   いちばん強い雰囲気の 3 色で背景を染める
 * ========================================================= */
// 白い下地に薄く重ねる色（そのまま重ねるとパステル調になる）
const MOODS = {
  calm: { label: '平常', colors: ['#7cc4ff', '#8fe3c8', '#b9a8ff'] },
  happy: { label: '楽しい', colors: ['#ff9f1c', '#ff4f8b', '#ffd23f'] },
  excited: { label: 'ワクワク', colors: ['#00b4ff', '#ffe600', '#ff3cac'] },
  sad: { label: '悲しい', colors: ['#3a6bd6', '#6f9bea', '#7b6bc0'] },
  serious: { label: 'シリアス', colors: ['#56657d', '#6d5a93', '#3f7d6a'] },
  fear: { label: '怖い', colors: ['#6a1b9a', '#3a1f6e', '#1f6b5a'] },
  angry: { label: '怒り', colors: ['#ff2a2a', '#ff7a00', '#c4001f'] },
};
// 単語のムード / 発話の感情 → 雰囲気
const WORD_MOOD_ATM = { happy: 'happy', surprise: 'excited', sad: 'sad', cool: 'serious', fear: 'fear', angry: 'angry' };
const EMO_ATM = { joy: 'happy', surprise: 'excited', sad: 'sad', fear: 'fear', anger: 'angry' };
const atmosphere = { mood: 'calm', score: Object.fromEntries(Object.keys(MOODS).map((k) => [k, 0])) };

function feedAtmosphere(c) {
  // 新しいページが来るたびに前の雰囲気を弱める（最近の発言ほど強く効く）
  for (const k in atmosphere.score) atmosphere.score[k] *= 0.75;
  for (const k of c.chunks) {
    const m = WORD_MOOD_ATM[MOOD_OF[k.category]];
    if (m) atmosphere.score[m] += 1;
  }
  const e = EMO_ATM[c.emotion];
  if (e) atmosphere.score[e] += 2 * c.strength;
  // 感情のこもらない落ち着いた話が続くときは、ほんのり平常へ戻す
  if (c.emotion === 'neutral') atmosphere.score.calm += 0.5;
}

function updateAtmosphere(dt) {
  const decay = Math.pow(0.5, dt / CONFIG.moodHalfLife);
  let best = 'calm';
  let bestV = 1.2; // これを超える雰囲気が無ければ「平常」
  for (const k in atmosphere.score) {
    atmosphere.score[k] *= decay;
    if (k !== 'calm' && atmosphere.score[k] > bestV) {
      best = k;
      bestV = atmosphere.score[k];
    }
  }
  if (best !== 'calm' && atmosphere.score.calm > bestV * 1.5) best = 'calm';
  atmosphere.mood = best;
}

/* =========================================================
 * 今の話の要約（中央の大きな絵文字）
 *   最近よく話に出た話題の絵文字を、画面の中央に大きく薄く出す。
 *   顔・ハートなど気分を表す絵文字は、話題そのものより控えめに数える
 * ========================================================= */
const summary = { cur: '', prev: '', changedAt: 0 };
const FACE_EMOJI = new Set(typeof CLDR_EMOJI_FACE === 'undefined' ? [] : [...CLDR_EMOJI_FACE]);

function updateSummary(now, dt) {
  const decay = Math.pow(0.5, dt / CONFIG.summaryHalfLife);
  let best = '';
  let bestV = 0.8; // これより話に出ていなければ出さない
  for (const t of topics) {
    t.recent *= decay;
    const v = t.recent * (FACE_EMOJI.has(t.emoji.replace(/\ufe0f/g, '')) ? 0.4 : 1);
    // 今の要約は少し有利にする（コロコロ入れ替わらないように）
    const bias = t.emoji === summary.cur ? 1.25 : 1;
    if (v * bias > bestV) {
      best = t.emoji;
      bestV = v * bias;
    }
  }
  if (best !== summary.cur) {
    summary.prev = summary.cur;
    summary.cur = best;
    summary.changedAt = now;
  }
}

function drawSummary(now) {
  if (!CONFIG.showTopics) return;
  const q = clamp((now - summary.changedAt) / 1500, 0, 1); // 入れ替わりはゆっくりクロスフェード
  const draw = (emoji, a, s) => {
    if (!emoji || a <= 0.001) return;
    const size = H * 0.62 * s * (1 + Math.sin(now / 2400) * 0.025);
    ctx.save();
    ctx.globalAlpha = CONFIG.summaryAlpha * a;
    ctx.translate(W / 2, H * 0.45);
    ctx.rotate(Math.sin(now / 6000) * 0.05);
    ctx.scale(size / U, size / U);
    drawEmoji(emoji);
    ctx.restore();
  };
  draw(summary.prev, 1 - q, 1 + q * 0.15);
  draw(summary.cur, q, 0.85 + easeOutCubic(q) * 0.15);
}

function drawBackground(now, emotion, I, dt) {
  updateAtmosphere(dt);
  updateSummary(now, dt);

  // 白い下地を、4 つの手がかりで染める
  //   話の内容（＋表情の積み重ね）→ 会話の雰囲気の 3 色 / 今の表情 → 1 色目を表情の色に寄せる
  //   声の大きさ → 色の濃さと広がり / 声の高さ → 色のかたまりが上へ昇る（低い声は下に沈む）
  const vol = features.volume;
  const pal = MOODS[atmosphere.mood].colors;
  const expr = features.faceDetected ? currentExpression() : 'neutral';
  const exprK = expr === 'neutral' ? 0 : clamp(features.expr[expr] * 1.2, 0, 0.8);
  const base = bgState.base;
  const baseTarget = hexToRgb(pal[0]).map((v) => lerp(255, v, 0.08 + vol * 0.1));
  for (let j = 0; j < 3; j++) base[j] = lerp(base[j], baseTarget[j], 0.03);
  ctx.fillStyle = `rgb(${base[0] | 0},${base[1] | 0},${base[2] | 0})`;
  ctx.fillRect(0, 0, W, H);
  const R = Math.max(W, H) * (0.5 + vol * 0.3);
  const rise = (features.pitchExcite - 0.3) * H * 0.35;
  for (let i = 0; i < 3; i++) {
    let target = hexToRgb(pal[i]);
    if (i === 0 && exprK > 0) {
      const e = hexToRgb(EMOTIONS[expr].glow);
      target = target.map((v, j) => lerp(v, e[j], exprK));
    }
    const c = bgState.blobs[i];
    for (let j = 0; j < 3; j++) c[j] = lerp(c[j], target[j], 0.02);
    const x = W * (0.5 + 0.38 * Math.sin(now / (13000 + i * 3700) + i * 2.1));
    const y = H * (0.5 + 0.3 * Math.cos(now / (11000 + i * 2900) + i * 1.3)) - rise;
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.22 + vol * 0.3;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = 1;

  // 今の話の要約（いちばん話題になっている絵文字）を中央に大きく
  drawSummary(now);
  // 会話に出た話題（キーワードの絵文字）を薄く
  drawTopics(now, dt);

  // 集中線（驚き・怒りで強く叫んだときだけ）
  const want = (emotion === 'surprise' || emotion === 'anger') && I > 0.55 ? (I - 0.55) * 2.2 : 0;
  bgState.speed = lerp(bgState.speed, want, 0.08);
  if (bgState.speed > 0.03) {
    if (now - speedLinesAt > 90) {
      speedLinesAt = now;
      speedLines = [];
      for (let i = 0; i < 70; i++) speedLines.push({ a: rand(0, Math.PI * 2), w: rand(0.003, 0.012), r: rand(0.38, 0.55) });
    }
    const R = Math.hypot(W, H);
    const m = Math.min(W, H);
    ctx.fillStyle = '#111111'; // 白い背景なので、漫画の集中線のように黒で
    ctx.globalAlpha = bgState.speed * 0.1;
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

  // 画面フラッシュ（控えめ）
  if (fx.flash > 0.005) {
    ctx.globalAlpha = fx.flash;
    ctx.fillStyle = fx.flashColor;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    fx.flash *= 0.85;
  }
}

/* =========================================================
 * 描画: 吹き出し（感情で輪郭が変わる）
 * ========================================================= */
function bubblePath(shape, a, b, now, seed) {
  const r = mulberry32(seed);
  const t = now / 1000;
  // 大きな吹き出しほどトゲ・もこもこの数を増やす（1 つ 1 つの大きさを揃える）
  const size = (a + b) / U;
  const spikes = Math.round(clamp(size * (shape === 'burst' ? 5 : 2.5), 14, 90));
  const N = Math.max(160, spikes * 6);
  const amps = Array.from({ length: spikes }, () => r());
  const m = Math.min(a, b, U * 1.5);
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    // 角丸の四角に近い楕円（横長の文章の四隅も覆える）
    let x = a * Math.sign(c) * Math.pow(Math.abs(c), 0.3);
    let y = b * Math.sign(s) * Math.pow(Math.abs(s), 0.3);
    let f = 1;
    switch (shape) {
      case 'burst': {
        // ウニフラッシュ: 細かいトゲ
        const k = (i / N) * spikes;
        const frac = k - Math.floor(k);
        f = 1 + (1 - Math.abs(frac * 2 - 1)) * (0.12 + amps[Math.floor(k) % spikes] * 0.1);
        break;
      }
      case 'jagged': {
        // 怒り: 大きく不揃いなギザギザ
        const k = (i / N) * spikes;
        const frac = k - Math.floor(k);
        f = 0.96 + (1 - Math.abs(frac * 2 - 1)) * (0.15 + amps[Math.floor(k) % spikes] * 0.2);
        break;
      }
      case 'cloud':
        // 喜び: もこもこ
        f = 1 + 0.12 * Math.abs(Math.sin((th * spikes) / 2 + t * 0.6));
        break;
      case 'wavy':
        // 恐怖: 不気味に波打つ
        f = 1 + 0.08 * Math.sin((th * spikes) / 2 + t * 3) + 0.04 * Math.sin(th * spikes - t * 5);
        break;
      case 'drip':
        // 悲しみ: ゆっくりたゆたう
        f = 1 + 0.06 * Math.sin((th * spikes) / 3 + t);
        break;
    }
    // トゲや波は、吹き出しの大きさに比例させず、短い辺を基準にした一定の長さで外へ出す（横長でもはみ出さない）
    const d = (f - 1) * m * 2;
    x += d * c;
    y += d * s;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawBubble(c, now) {
  const e = EMOTIONS[c.emotion];
  const shape = e.bubble;
  const age = (now - c.born) / 300;
  const pop = age < 1 ? easeOutBack(clamp(age, 0, 1), 2.2) : 1;
  const breathe = 1 + (c.live ? features.volume * 0.015 : 0);
  const a = c.bubbleA * pop * breathe;
  const b = c.bubbleB * pop * breathe;
  if (a <= 0 || b <= 0) return;
  const lw = Math.max(4, H * 0.006) / c.scale;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = e.line;
  ctx.fillStyle = e.fill;
  // しっぽ（普通・喜び・悲しみの吹き出しだけ）。左下から出す
  const tail = shape === 'speech' || shape === 'cloud' || shape === 'drip';
  const x0 = -a + Math.min(a, U * 1.2);
  const tailPath = () => {
    ctx.beginPath();
    ctx.moveTo(x0, b - U * 0.3);
    ctx.lineTo(x0 - U * 0.45, b + U * 0.55);
    ctx.lineTo(x0 + U * 0.6, b - U * 0.3);
    ctx.closePath();
  };
  // 影
  ctx.save();
  ctx.translate(lw * 1.4, lw * 1.4);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
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
  ctx.restore();
}

/* =========================================================
 * 描画: 文字（テレビのテロップ風）
 * ========================================================= */
function glyph(k, ch, simple) {
  const [c1, c2] = k.palette;
  if (simple) {
    // 端に寄せたページ・閉じていくページは、黒フチ＋塗りだけの軽い描き方（1 文字 2 回の描画で済ませる）
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 24;
    ctx.strokeText(ch, 0, 0);
    ctx.fillStyle = c1;
    ctx.fillText(ch, 0, 0);
    return;
  }
  if (k.gradKey !== c1 + c2) {
    k.gradKey = c1 + c2;
    k.grad = ctx.createLinearGradient(0, -U * 0.45, 0, U * 0.45);
    k.grad.addColorStop(0, '#ffffff');
    k.grad.addColorStop(0.3, c1);
    k.grad.addColorStop(1, c2);
  }
  // 影
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 32;
  ctx.strokeText(ch, 6, 8);

  switch (k.style) {
    case 'telop': // グラデ文字＋白フチ＋黒フチ
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 30;
      ctx.strokeText(ch, 0, 0);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 14;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = k.grad;
      ctx.fillText(ch, 0, 0);
      break;
    case 'pop': // 白文字＋色フチ＋黒フチ
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 34;
      ctx.strokeText(ch, 0, 0);
      ctx.strokeStyle = c2;
      ctx.lineWidth = 18;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillText(ch, 0, 0);
      break;
    case 'solid': // 単色＋濃い色の太フチ
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 32;
      ctx.strokeText(ch, 0, 0);
      ctx.strokeStyle = c2;
      ctx.lineWidth = 20;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = c1;
      ctx.fillText(ch, 0, 0);
      break;
    case 'neon': { // 光るフチ
      const ga = ctx.globalAlpha;
      ctx.strokeStyle = c2;
      ctx.globalAlpha = ga * 0.35;
      ctx.lineWidth = 38;
      ctx.strokeText(ch, 0, 0);
      ctx.globalAlpha = ga;
      ctx.lineWidth = 15;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillText(ch, 0, 0);
      break;
    }
    case 'horror': { // グリッチ残像＋暗い文字
      const ga = ctx.globalAlpha;
      ctx.globalAlpha = ga * 0.6;
      ctx.fillStyle = '#ff0044';
      ctx.fillText(ch, jitter(8), jitter(4));
      ctx.fillStyle = '#00e5ff';
      ctx.fillText(ch, jitter(8), jitter(4));
      ctx.globalAlpha = ga;
      ctx.strokeStyle = c2;
      ctx.lineWidth = 22;
      ctx.strokeText(ch, 0, 0);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 10;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = c1;
      ctx.fillText(ch, 0, 0);
      break;
    }
  }
}

// 単語全体の登場アニメーション（p: 0→1）
function chunkEntrance(k, p) {
  const o = { x: 0, y: 0, r: 0, s: 1, sx: 1, sy: 1, a: 1 };
  if (p >= 1) return o;
  const q = 1 - p;
  switch (k.entrance) {
    case 'slam': // 巨大な状態から叩きつける
      o.s = lerp(2.6, 1, easeOutCubic(p));
      o.a = clamp(p * 3, 0, 1);
      break;
    case 'stomp': // ドンと踏みつけて揺れる
      o.s = lerp(1.8, 1, easeOutBack(p, 3));
      o.x = jitter(U * 0.15 * q);
      o.y = jitter(U * 0.15 * q);
      break;
    case 'crash': // 横から突っ込んでくる
      o.x = k.dir * (1 - easeOutBack(p, 1.4)) * U * 4;
      o.r = k.dir * q * 0.6;
      break;
    case 'bounce': // 上から落ちて弾む
    case 'drop':
      o.y = -(1 - easeOutBounce(p)) * U * 3;
      break;
    case 'pop':
      o.s = easeOutBack(p, 4);
      break;
    case 'zoom':
      o.s = easeOutBack(p, 2);
      o.a = clamp(p * 2, 0, 1);
      break;
    case 'burst': // 弾けるように出る
      o.s = easeOutBack(p, 5);
      o.r = q * 0.3 * k.dir;
      break;
    case 'spin': // 回転しながら出る
      o.r = (1 - easeOutBack(p)) * Math.PI * 2 * k.dir;
      o.s = easeOutCubic(p);
      break;
    case 'swing': // ぶら下がって揺れながら止まる
      o.r = k.dir * 0.7 * Math.cos(p * 10) * q * q;
      o.a = clamp(p * 4, 0, 1);
      break;
    case 'balloon': // 風船のように下からふわっと膨らむ
      o.y = q * q * U * 1.5;
      o.s = easeOutBack(p, 2.5);
      break;
    case 'flipX': // 縦にくるっと開く
      o.sy = easeOutBack(p, 2.5);
      break;
    case 'flipY': // 横にくるっと開く
      o.sx = easeOutBack(p, 2.5);
      break;
    case 'slideL':
    case 'slideR': // 横から滑り込む
      o.x = (k.entrance === 'slideL' ? -1 : 1) * (1 - easeOutExpo(p)) * U * 3;
      o.a = p;
      break;
    case 'fadeUp': // 下からふわっと
      o.y = (1 - easeOutCubic(p)) * U * 0.8;
      o.a = p;
      break;
    case 'fadeDown':
    case 'fallSlow': // 上からゆっくり降りてくる
      o.y = -(1 - easeOutCubic(p)) * U * (k.entrance === 'fallSlow' ? 2 : 1);
      o.a = p;
      break;
    case 'sink': // 重たく沈み込む
      o.y = -(1 - easeOutCubic(p)) * U * 0.5;
      o.s = lerp(1.15, 1, p);
      o.a = p;
      break;
    case 'creep': // 暗闇からじわじわ
      o.a = p * p;
      o.s = lerp(0.85, 1, p);
      break;
    case 'flicker': // チカチカ点滅しながら現れる
      o.a = Math.random() < 0.35 + p * 0.65 ? 1 : 0.1;
      break;
    case 'shakeIn': // 震えながら現れる
      o.x = jitter(U * 0.3 * q);
      o.y = jitter(U * 0.3 * q);
      o.a = clamp(p * 3, 0, 1);
      break;
  }
  return o;
}

// 1 文字ずつの登場アニメーション（ct: その文字が出てからの秒数）
function charEntrance(k, ct, sad) {
  const o = { x: 0, y: 0, r: 0, s: 1, a: 1, ch: null };
  const d = sad ? 0.6 : 0.3;
  const q = clamp(ct / d, 0, 1);
  if (!CHAR_ENTRANCES.has(k.entrance)) {
    // 基本は 1 文字ずつポンと出る
    if (ct < 0.16) o.s = easeOutBack(ct / 0.16, 2);
    return o;
  }
  if (q >= 1) return o;
  switch (k.entrance) {
    case 'jump': // 1 文字ずつ跳ねて着地
      o.y = -Math.sin(q * Math.PI) * U * 0.6;
      break;
    case 'waveIn': // 下から波のように
      o.y = (1 - easeOutBack(q, 2.5)) * U * 0.8;
      o.a = q;
      break;
    case 'drip': // 1 文字ずつしずくのように落ちる
      o.y = -(1 - easeOutBounce(q)) * U * 1.5;
      o.a = q;
      break;
    case 'typewriter': // タイプライター（出た瞬間にパッと表示）
      break;
    case 'wipe': // 左からスッと流れ込む
      o.x = -(1 - easeOutCubic(q)) * U * 0.5;
      o.a = q;
      break;
    case 'scramble': // ランダムな文字が回ってから確定
      if (q < 0.8) o.ch = SCRAMBLE_POOL[Math.floor(Math.random() * SCRAMBLE_POOL.length)];
      break;
    case 'glitchIn': // ノイズまじりに現れる
      o.x = jitter(U * 0.3 * (1 - q));
      o.a = Math.random() < q ? 1 : 0.25;
      break;
  }
  return o;
}

// 登場後もムードに合わせて動き続ける
function charIdle(mood, now, t, i, str, I) {
  const o = { x: 0, y: 0, r: 0, s: 1 };
  const A = 0.6 + I * 0.8;
  switch (mood) {
    case 'happy': // ぴょこぴょこ弾む
      o.y = -Math.abs(Math.sin(now / 220 + i * 0.7)) * U * 0.08 * A;
      o.r = Math.sin(now / 300 + i) * 0.07;
      break;
    case 'sad': // うなだれて、ゆっくり沈む
      o.y = (Math.sin(now / 900 + i * 0.5) * 0.5 + 0.5) * U * 0.08 + i * U * 0.015;
      o.r = 0.05;
      break;
    case 'fear': // 小刻みに震える
      o.x = jitter(U * 0.022 * (0.6 + str));
      o.y = jitter(U * 0.022 * (0.6 + str));
      break;
    case 'angry': // ドクドク脈打つ
      o.x = jitter(U * 0.025);
      o.y = jitter(U * 0.025);
      o.s = 1 + 0.06 * Math.abs(Math.sin(now / 70));
      break;
    case 'surprise': // ときどき跳び上がる
      o.y = -Math.pow(Math.max(0, Math.sin(now / 260 + i * 0.4)), 8) * U * 0.2 * A;
      break;
    case 'cool': // ほぼ静止（キリッと）
      break;
    default: // calm: ゆるやかに波打つ
      o.y = Math.sin(now / 600 + i * 0.5) * U * 0.02 * A;
  }
  return o;
}

function drawChunk(c, k, now, I) {
  if (k.x === null) return;
  const t = (now - k.born) / 1000;
  const p = clamp((now - k.born) / k.enterTime, 0, 1);
  const mood = k.mood;
  const sad = mood === 'sad';

  const en = chunkEntrance(k, p);
  // 単語全体のゆるい浮遊（クールな単語はほぼ動かさない）
  const amp = mood === 'cool' ? 0.2 : 0.5 + I * 0.8 + features.motion * 0.8;
  const floatY = Math.sin(t * 1.6 + k.phase) * U * 0.03 * amp;
  const floatR = Math.sin(t * 1.2 + k.phase) * 0.015 * amp;
  const isLast = c.live && k === c.chunks[c.chunks.length - 1];
  const beat = c.live ? 1 + features.volume * (isLast ? 0.18 : 0.05) : 1;
  const droop = sad ? 0.04 * k.dir : 0;

  ctx.save();
  ctx.translate(k.x + en.x, k.y + en.y + floatY);
  ctx.rotate(k.tilt + floatR + en.r + droop);
  const s = k.s * en.s * beat;
  ctx.scale(s * en.sx, s * en.sy);
  const baseAlpha = c.alpha * en.a;
  ctx.font = k.font;

  k.chars.forEach((ch, i) => {
    const ct = (now - ch.born) / 1000;
    if (ct < 0) return;
    const ce = charEntrance(k, ct, sad);
    const id = charIdle(mood, now, t, i, c.strength, I);
    const rot = ce.r + id.r;
    ctx.save();
    ctx.globalAlpha = baseAlpha * ce.a;
    ctx.translate(ch.ox + ce.x + id.x, ch.oy + ce.y + id.y);
    if (rot) ctx.rotate(rot);
    const sc = ce.s * id.s;
    if (sc !== 1) ctx.scale(sc, sc);
    glyph(k, ce.ch || ch.ch, c.simple);
    ctx.restore();
  });

  // 絵文字: 単語の後ろにポンと出て、ぷかぷか揺れる
  if (k.emoji && now >= k.emojiBorn) {
    const et = (now - k.emojiBorn) / 1000;
    const es = (et < 0.35 ? easeOutBack(et / 0.35, 3) : 1) * EMOJI_SIZE * 0.9;
    ctx.save();
    ctx.globalAlpha = baseAlpha;
    ctx.translate(k.ex, k.ey + Math.sin(now / 350 + k.phase) * U * 0.06);
    ctx.rotate(Math.sin(now / 500 + k.phase) * 0.15);
    ctx.scale(es, es);
    drawEmoji(k.emoji);
    ctx.restore();
  }
  ctx.restore();
}

function drawCaption(c, now) {
  if (!c.chunks.length || !c.scale || c.top === null) return;
  // 画面の外にある吹き出しは描かない
  if (c.top > H || c.top + c.outerH < 0) return;
  const I = c.live ? features.intensity : c.finalI;
  let alpha = c.fade ?? 1;
  let oy = 0;
  if (c.state === 'leaving') {
    // 消えるときは上へ抜けながら薄くなる
    const q = clamp((now - c.leftAt) / CONFIG.exitDur, 0, 1);
    alpha *= 1 - q;
    oy = -q * q * H * 0.1;
  }
  if (alpha < 0.01) return;

  ctx.save();
  // 文字の範囲の左上を原点にする（単語の位置は基準単位）
  ctx.translate(c.left, c.top + c.textTop + oy);
  ctx.scale(c.scale, c.scale);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.translate(c.bw / 2, c.bh / 2);
  drawBubble(c, now);
  ctx.restore();
  c.alpha = alpha;
  for (const k of c.chunks) drawChunk(c, k, now, I);
  // しゃべっている最中は、最後の単語の後ろでカーソルが点滅する（今ここを打ち込んでいる）
  if (c.live) drawCursor(c, now);
  c.alpha = 1;
  ctx.restore();
}

function drawCursor(c, now) {
  const k = c.chunks[c.chunks.length - 1];
  if (!k || k.x === null || !k.w) return;
  if (Math.sin(now / 130) < -0.2) return;
  ctx.globalAlpha = c.alpha * 0.8;
  ctx.fillStyle = EMOTIONS[c.emotion].glow;
  const h = U * 0.9 * k.s;
  ctx.fillRect(k.x + (k.w * k.s) / 2 + U * 0.12, k.y - h / 2, U * 0.12, h);
  ctx.globalAlpha = 1;
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
  drawBackground(now, emotion, I, dt);

  // カメラワーク: ごくゆっくり動き、単語が出るたびに少し寄る
  cam.punch = Math.min(cam.punch, 0.015) * 0.88;
  const zoom = 1 + cam.punch;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -H / 2);
  if (fx.shake > 0.3) {
    ctx.translate(jitter(fx.shake), jitter(fx.shake));
    fx.shake *= 0.85;
  }

  // 新しい 2 つの吹き出し以外は、軽い描き方にする（文字起こしは画面に文字が多いので）
  captions.forEach((c, i) => {
    c.simple = i < captions.length - 2;
    drawCaption(c, now);
  });
  drawParticles(dt);
  ctx.restore();

  // 下端の音量バー（聞いていることが分かるように）
  const color = liveCaption ? EMOTIONS[liveCaption.emotion].glow : '#6f8cff';
  const bw = W * features.volume;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.fillRect((W - bw) / 2, H - 3 - features.volume * 6, bw, 3 + features.volume * 6);
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
  updateFace(now);
  feedFaceAtmosphere(dt);
  arrangeTranscript(now);

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
  const main = liveCaption || captions[captions.length - 1];
  const words = main ? main.chunks.map((k) => `${k.text}${k.emoji}<small>(${CATEGORIES[k.category].label}/${k.entrance}/${k.family})</small>`).join(' ') : '';
  const rows = [
    ['音量', features.volume, `${features.db.toFixed(0)}dB`],
    ['ピッチ', features.pitchExcite, `${features.pitch.toFixed(0)}Hz`],
    ['基準ピッチ', null, `${features.pitchBase.toFixed(0)}Hz`],
    ['話速', features.rateNorm, `${features.rate.toFixed(1)}字/s`],
    ['頭の動き', features.motion, features.faceDetected ? features.motion.toFixed(2) : '顔なし'],
    ...Object.entries(features.expr).map(([k, v]) => [EXPRESSION_LABEL[k], v, v.toFixed(2)]),
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
    `<div class="row"><span class="label">表情</span><span>${features.faceDetected ? EXPRESSION_LABEL[currentExpression()] : '顔なし'}</span></div>` +
    `<div class="row"><span class="label">雰囲気</span><span style="color:${MOODS[atmosphere.mood].colors[0]}">${MOODS[atmosphere.mood].label}</span>` +
    `<span style="opacity:0.6">&nbsp;${Object.entries(atmosphere.score)
      .filter(([, v]) => v > 0.05)
      .map(([k, v]) => `${MOODS[k].label}${v.toFixed(1)}`)
      .join(' ')}</span></div>` +
    `<div class="row"><span class="label">要約</span><span>${summary.cur || 'なし'}</span></div>` +
    `<div class="row"><span class="label">話題</span><span>${
      [...topics].sort((a, b) => b.weight - a.weight).map((t) => `${t.emoji}${t.weight}`).join(' ') || 'なし'
    }</span></div>` +
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
  initFace();
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
      for (const c of captions) c.leave(performance.now());
      topics.length = 0;
      for (const k in atmosphere.score) atmosphere.score[k] = 0;
      summary.cur = '';
      liveCaption = null;
      break;
    case 't':
    case 'T':
      CONFIG.showTopics = !CONFIG.showTopics;
      break;
    case 'v':
    case 'V':
      if (face.landmarker) camView.hidden = !camView.hidden;
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
