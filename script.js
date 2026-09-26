'use strict';

/* =========================================================
 * 激面白字幕メーカー
 *  - Web Speech API : 音声認識（#1）
 *  - Web Audio API  : 音量・ピッチ・話速の解析（#2）
 *  - MediaPipe Pose : 体の動きの大きさ（#3）
 *  - 声+動きの複合スコアで感情の種類・強さを推定（#4）
 *  - Canvas         : 感情を誇張した字幕アニメーション（#5）
 *  - フルスクリーン   : F キー / F11（#6）
 * ========================================================= */

// ---------- 設定 ----------
const CONFIG = {
  lang: 'ja-JP',
  fontFamily: "'Dela Gothic One', 'Hiragino Sans', 'Meiryo', sans-serif",
  minFont: 40,
  maxFontRatio: 0.26, // 画面の高さに対する最大文字サイズ
  maxCaptions: 7,
  captionLife: 12000, // 確定後に表示し続ける時間(ms)
  dbFloor: -58, // この音量(dBFS)以下は無音扱い
  dbCeil: -12, // この音量で最大
  charStagger: 28, // 1文字ずつポップインする間隔(ms)
  pitchMin: 70,
  pitchMax: 600,
  mediapipeVersion: '0.10.14',
  poseModel:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

// 感情ごとの色
const EMOTIONS = {
  neutral: { label: '平常', color: '#ffffff', glow: '#6f8cff' },
  joy: { label: '喜び', color: '#ffd23f', glow: '#ff8c00' },
  surprise: { label: '驚き', color: '#3fe0ff', glow: '#0077ff' },
  fear: { label: '恐怖', color: '#c9a6ff', glow: '#7a00ff' },
  anger: { label: '怒り', color: '#ff4d4d', glow: '#ff0000' },
};

// 感情キーワード（TRPG 用語も含む）
const KEYWORDS = {
  fear: ['怖', 'こわ', 'コワ', '恐', 'やば', 'ヤバ', '幽霊', 'おばけ', 'お化け', 'ゾンビ', '死', '血', '悲鳴',
    '助けて', 'たすけて', '逃げ', '呪', '闇', 'ぎゃ', 'ギャ', 'ひぃ', 'ヒィ', 'ホラー', '不気味', '震え',
    '正気度', 'SAN', '発狂', 'ファンブル'],
  surprise: ['えっ', 'まじ', 'マジ', 'うそ', '嘘', 'ほんと', '本当', 'びっくり', '驚', 'すご', 'スゴ', 'まさか',
    'なんで', '信じられ', 'えー', 'ええ'],
  joy: ['嬉し', 'うれし', '楽し', 'たのし', 'やった', '最高', 'さいこう', '好き', 'ありがと', 'おめでと',
    'わーい', '笑', 'あはは', 'いいね', '成功', 'クリティカル', 'よっしゃ'],
  anger: ['怒', 'ふざけ', 'ムカ', 'むか', 'いい加減', 'うるさ', '許さ', 'ゆるさ', 'なんだと', 'バカ', 'ばか'],
};

// ---------- ユーティリティ ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const jitter = (amp) => (Math.random() - 0.5) * 2 * amp;
const fontStr = (size) => `${Math.round(size)}px ${CONFIG.fontFamily}`;

function easeOutBack(t, s = 1.70158) {
  t -= 1;
  return t * t * ((s + 1) * t + s) + 1;
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
const audio = { ctx: null, analyser: null, buf: null, frame: 0 };

function initAudio(stream) {
  audio.ctx = new AudioContext();
  audio.ctx.resume();
  const src = audio.ctx.createMediaStreamSource(stream);
  audio.analyser = audio.ctx.createAnalyser();
  audio.analyser.fftSize = 2048;
  src.connect(audio.analyser);
  audio.buf = new Float32Array(audio.analyser.fftSize);
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
  // 立ち上がりは速く、減衰はゆっくり
  features.volume += (v - features.volume) * (v > features.volume ? 0.5 : 0.08);

  // ピッチ推定は負荷が高いので 2 フレームに 1 回、声がある時だけ
  audio.frame++;
  if (v > 0.15 && audio.frame % 2 === 0) {
    const p = detectPitch(buf, audio.ctx.sampleRate);
    if (p > 0) {
      features.pitch = features.pitch ? lerp(features.pitch, p, 0.3) : p;
      features.pitchBase = features.pitchBase ? lerp(features.pitchBase, p, 0.005) : p;
    }
  }
  const target = features.pitchBase ? clamp((features.pitch / features.pitchBase - 1) / 0.5, 0, 1) : 0;
  features.pitchExcite = lerp(features.pitchExcite, v > 0.1 ? target : 0, 0.15);
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
const body = { landmarker: null, lastVideoTime: -1, prev: null, prevTime: 0, lm: null };

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
    camView.hidden = false;
    toast('動き検出 ON');
  } catch (err) {
    console.error(err);
    toast('動き検出を読み込めませんでした（声だけで動作します）', 5000);
  }
}

function updateBody(now) {
  if (!body.landmarker || video.readyState < 2 || video.currentTime === body.lastVideoTime) {
    return;
  }
  body.lastVideoTime = video.currentTime;
  const res = body.landmarker.detectForVideo(video, now);
  const lm = res.landmarks && res.landmarks[0];
  body.lm = lm || null;

  if (!lm) {
    features.bodyDetected = false;
    features.motion = lerp(features.motion, 0, 0.1);
    features.spread = lerp(features.spread, 0, 0.1);
    features.handsUp = lerp(features.handsUp, 0, 0.1);
    features.handsFace = lerp(features.handsFace, 0, 0.1);
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
  features.motion = lerp(features.motion, raw, raw > features.motion ? 0.5 : 0.06);

  const [nose, lw, rw] = [lm[0], lm[15], lm[16]];
  const wristsVisible = visible(lw) && visible(rw);
  const spread = wristsVisible ? clamp((dist(lw, rw) / shoulder - 1.5) / 2.5, 0, 1) : 0;
  // 画像座標は y が下向きなので「手首の y < 鼻の y」が手を挙げた状態
  const up = ((visible(lw) && lw.y < nose.y ? 1 : 0) + (visible(rw) && rw.y < nose.y ? 1 : 0)) / 2;
  const face = ((visible(lw) && dist(lw, nose) < shoulder * 0.5 ? 1 : 0) + (visible(rw) && dist(rw, nose) < shoulder * 0.5 ? 1 : 0)) / 2;
  features.spread = lerp(features.spread, spread, 0.2);
  features.handsUp = lerp(features.handsUp, up, 0.2);
  features.handsFace = lerp(features.handsFace, face, 0.2);

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
 * 感情推定
 * ========================================================= */
// テキストからキーワードを数え、「怖い単語」の文字位置を返す
function analyzeText(text) {
  const kw = { joy: 0, surprise: 0, fear: 0, anger: 0 };
  const scary = new Set();
  for (const [emo, words] of Object.entries(KEYWORDS)) {
    for (const w of words) {
      let idx = text.indexOf(w);
      while (idx !== -1) {
        kw[emo] += 1;
        if (emo === 'fear') for (let k = 0; k < w.length; k++) scary.add(idx + k);
        idx = text.indexOf(w, idx + w.length);
      }
    }
  }
  kw.surprise += (text.match(/[!！]/g) || []).length * 0.4 + (text.match(/[?？]/g) || []).length * 0.3;
  return { kw, scary };
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
  };
}

function pickEmotion(kw, prosody) {
  const weight = { joy: 1.2, surprise: 1.0, fear: 1.4, anger: 1.2 };
  let best = 'neutral';
  let bestScore = 0.55;
  for (const k of Object.keys(weight)) {
    const s = kw[k] * weight[k] + (prosody[k] || 0);
    if (s > bestScore) {
      best = k;
      bestScore = s;
    }
  }
  return { type: best, strength: best === 'neutral' ? 0 : clamp(bestScore / 2, 0.3, 1) };
}

/* =========================================================
 * 字幕
 * ========================================================= */
const captions = [];
let liveCaption = null; // 発話中（認識途中）の字幕
const rings = []; // 衝撃波エフェクト
const fx = { shake: 0, flashColor: '#000', flash: 0 };

function sizeFor(intensity, textLen) {
  const maxFont = H * CONFIG.maxFontRatio;
  const size = lerp(CONFIG.minFont, maxFont, Math.pow(clamp(intensity, 0, 1), 1.3));
  // 長文が画面からはみ出さないように上限を決める
  const byLen = Math.sqrt((W * 0.8 * H * 0.5) / (Math.max(1, textLen) * 1.2));
  return Math.max(CONFIG.minFont * 0.7, Math.min(size, byLen));
}

class Caption {
  constructor(now) {
    this.text = '';
    this.born = now;
    this.live = true;
    this.committedAt = 0;
    this.fontSize = CONFIG.minFont;
    this.peak = features.recentPeak;
    this.sumI = 0;
    this.nI = 0;
    this.finalI = 0;
    this.kw = { joy: 0, surprise: 0, fear: 0, anger: 0 };
    this.prosody = { joy: 0, surprise: 0, fear: 0, anger: 0 };
    this.scary = new Set();
    this.emotion = 'neutral';
    this.strength = 0;
    this.charBorn = [];
    this.tilt = rand(-0.1, 0.1);
    this.x = W / 2;
    this.y = H / 2;
    this.cx = this.x;
    this.cy = this.y;
    this.scale = 0.6;
    this.alpha = 1;
    this.punch = 0;
    this.dead = false;
    this.layout = null;
  }

  setText(text, now) {
    let delay = 0;
    for (let i = 0; i < text.length; i++) {
      if (this.charBorn[i] === undefined) {
        this.charBorn[i] = now + delay;
        delay += CONFIG.charStagger;
      }
    }
    this.charBorn.length = text.length;
    // Web フォントは文字種ごとに分割配信されるので、使う文字を先読みさせる
    document.fonts.load(fontStr(64), text).catch(() => {});
    this.text = text;
    const a = analyzeText(text);
    this.kw = a.kw;
    this.scary = a.scary;
  }

  commit(now) {
    this.live = false;
    this.committedAt = now;
    const avg = this.nI ? this.sumI / this.nI : this.peak;
    this.finalI = clamp(this.peak * 0.75 + avg * 0.25, 0, 1);
    const emo = pickEmotion(this.kw, this.prosody);
    this.emotion = emo.type;
    this.strength = emo.strength;
    this.punch = 0.2 + 0.4 * this.finalI;
    if (this.finalI > 0.6 || this.emotion !== 'neutral') impact(this);
  }

  update(now, rank) {
    if (this.live) {
      const I = features.intensity;
      this.peak = Math.max(this.peak, features.recentPeak);
      if (features.volume > 0.1) {
        this.sumI += I;
        this.nI++;
        // 発話中の声の特徴を感情スコアとして蓄積
        const p = prosodyScores(features);
        for (const k in this.prosody) this.prosody[k] = lerp(this.prosody[k], p[k], 0.08);
      }
      const emo = pickEmotion(this.kw, this.prosody);
      this.emotion = emo.type;
      this.strength = emo.strength;
      // 発話中は「今の声」に追従して膨らむ
      const target = sizeFor(Math.max(I, this.peak * 0.55), this.text.length);
      this.fontSize = lerp(this.fontSize, target, 0.25);
    } else {
      this.fontSize = lerp(this.fontSize, sizeFor(this.finalI, this.text.length), 0.15);
    }

    // 新しい字幕を主役に、古い字幕は小さく暗く
    const focusScale = rank === 0 ? 1 : lerp(0.75, 0.5, Math.min(1, rank / 5));
    let focusAlpha = rank === 0 ? 1 : Math.max(0.15, 0.6 - rank * 0.08);
    if (!this.live) {
      const over = now - this.committedAt - CONFIG.captionLife;
      if (over > 0) focusAlpha *= Math.max(0, 1 - over / 1500);
      if (rank >= CONFIG.maxCaptions) focusAlpha = 0;
      if (focusAlpha <= 0 && this.alpha < 0.02) this.dead = true;
    }
    this.scale = lerp(this.scale, focusScale, 0.12);
    this.alpha = lerp(this.alpha, focusAlpha, 0.1);
    this.punch *= 0.88;

    this.doLayout();
    // 画面からはみ出さないように中心位置を補正
    const m = 24;
    const hw = (this.layout.width * this.scale) / 2;
    const hh = (this.layout.height * this.scale) / 2;
    const tx = hw * 2 > W - m * 2 ? W / 2 : clamp(this.x, hw + m, W - hw - m);
    const ty = hh * 2 > H - m * 2 ? H / 2 : clamp(this.y, hh + m, H - hh - m);
    this.cx = lerp(this.cx, tx, 0.15);
    this.cy = lerp(this.cy, ty, 0.15);
  }

  // 1 文字ずつの位置を計算（長い場合は折り返す）
  doLayout() {
    ctx.font = fontStr(this.fontSize);
    const maxW = W * 0.86;
    const lines = [];
    let line = { chars: [], width: 0 };
    for (let i = 0; i < this.text.length; i++) {
      const ch = this.text[i];
      const w = ctx.measureText(ch).width;
      if (line.width + w > maxW && line.chars.length) {
        lines.push(line);
        line = { chars: [], width: 0 };
      }
      line.chars.push({ ch, i, w, x: line.width });
      line.width += w;
    }
    lines.push(line);
    const lineH = this.fontSize * 1.18;
    this.layout = {
      lines,
      lineH,
      width: Math.max(...lines.map((l) => l.width)),
      height: lines.length * lineH,
    };
  }

  box() {
    const w = (this.layout ? this.layout.width : W * 0.4) * this.scale;
    const h = (this.layout ? this.layout.height : H * 0.2) * this.scale;
    return { x: this.cx - w / 2, y: this.cy - h / 2, w, h };
  }
}

// 既存の字幕となるべく重ならない位置を探す（画面全体に散らす）
function placeCaption(c) {
  const ew = W * 0.45;
  const eh = H * 0.22;
  const others = captions.filter((o) => o !== c && o.alpha > 0.05).map((o) => ({ b: o.box(), a: o.alpha }));
  let best = null;
  let bestScore = Infinity;
  for (let k = 0; k < 40; k++) {
    const x = rand(ew / 2 + 20, W - ew / 2 - 20);
    const y = rand(eh / 2 + 20, H - eh / 2 - 20);
    let score = Math.random() * 500;
    for (const o of others) {
      const ox = Math.max(0, Math.min(x + ew / 2, o.b.x + o.b.w) - Math.max(x - ew / 2, o.b.x));
      const oy = Math.max(0, Math.min(y + eh / 2, o.b.y + o.b.h) - Math.max(y - eh / 2, o.b.y));
      score += ox * oy * o.a;
    }
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  c.x = c.cx = best.x;
  c.y = c.cy = best.y;
}

function newCaption(now) {
  const c = new Caption(now);
  placeCaption(c);
  captions.push(c);
  return c;
}

// 大きな声・強い感情で確定したときの演出
function impact(c) {
  const emo = EMOTIONS[c.emotion];
  fx.shake = Math.max(fx.shake, 6 + c.finalI * 22);
  fx.flash = Math.max(fx.flash, 0.15 + 0.35 * c.finalI);
  fx.flashColor = emo.glow;
  rings.push({ x: c.cx, y: c.cy, r: 20, a: 0.9, color: emo.glow, speed: 0.8 + c.finalI * 1.6 });
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
  const c = newCaption(now);
  c.setText(text, now);
  const bangs = (text.match(/[!！]/g) || []).length;
  c.peak = Math.max(features.recentPeak, clamp(0.35 + bangs * 0.2, 0, 1));
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

  // Chrome は無音が続くと止まるので自動で再開する
  recognition.onend = () => {
    // 確定されないまま途切れた字幕は、その時点のテキストで確定させる
    if (liveCaption && liveCaption.text) commitUtterance(liveCaption.text);
    if (running) setTimeout(startRecognition, 200);
  };

  running = true;
  startRecognition();
}

function startRecognition() {
  try {
    recognition.start();
  } catch (err) {
    // すでに開始済みの場合は無視
  }
}

/* =========================================================
 * 描画
 * ========================================================= */
function drawCaption(c, now) {
  const L = c.layout;
  if (!L || !c.text || c.alpha < 0.01) return;
  const emo = EMOTIONS[c.emotion];
  const size = c.fontSize;
  const str = c.strength;
  const I = c.live ? features.intensity : c.finalI;
  const glow = c.live || now - c.committedAt < 2500;

  ctx.save();
  ctx.globalAlpha = c.alpha;
  ctx.translate(c.cx, c.cy);
  // 発話中は体の動きに合わせて字幕ごと揺さぶる
  const sway = c.live ? Math.sin(now / 90) * 0.08 * features.motion : 0;
  ctx.rotate(c.tilt * (0.4 + I) + sway);
  const s = c.scale * (1 + c.punch);
  ctx.scale(s, s);
  ctx.font = fontStr(size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const top = -((L.lines.length - 1) * L.lineH) / 2;
  L.lines.forEach((line, li) => {
    const baseY = top + li * L.lineH;
    const x0 = -line.width / 2;
    for (const ch of line.chars) {
      const born = c.charBorn[ch.i] ?? c.born;
      const t = (now - born) / 1000;
      if (t < 0) continue;

      // ポップイン（声が大きいほどオーバーシュートが強い）
      let sc = t < 0.45 ? easeOutBack(t / 0.45, 1.7 + I * 3) : 1;
      let dx = 0;
      let dy = 0;
      let rot = 0;

      switch (c.emotion) {
        case 'fear': // 全体がじわっと震える
          dx = jitter(size * 0.02 * (0.5 + str));
          dy = jitter(size * 0.02 * (0.5 + str));
          break;
        case 'surprise': // 跳ねて弾ける
          dy = -Math.abs(Math.sin(t * 9 + ch.i * 0.4)) * size * 0.28 * Math.exp(-t * 1.5);
          sc *= 1 + 0.15 * Math.exp(-t * 2) * Math.sin(t * 22);
          break;
        case 'joy': // うねうね波打つ
          dy = Math.sin(now / 220 + ch.i * 0.7) * size * 0.08 * (0.5 + str);
          rot = Math.sin(now / 300 + ch.i) * 0.12;
          break;
        case 'anger': // 小刻みに脈打つ
          dx = jitter(size * 0.035);
          dy = jitter(size * 0.035);
          sc *= 1 + 0.07 * Math.abs(Math.sin(now / 60));
          break;
      }

      // 怖い単語は感情の種類に関係なく激しく震える
      const scary = c.scary.has(ch.i);
      if (scary) {
        const amp = size * 0.07 * (0.6 + str);
        dx += jitter(amp);
        dy += jitter(amp);
        rot += jitter(0.2);
      }

      ctx.save();
      ctx.translate(x0 + ch.x + ch.w / 2 + dx, baseY + dy);
      if (rot) ctx.rotate(rot);
      if (sc !== 1) ctx.scale(sc, sc);

      if (scary) {
        // グリッチ風の残像
        ctx.globalAlpha = c.alpha * 0.6;
        ctx.fillStyle = '#ff0044';
        ctx.fillText(ch.ch, jitter(size * 0.08), jitter(size * 0.04));
        ctx.fillStyle = '#00e5ff';
        ctx.fillText(ch.ch, jitter(size * 0.08), jitter(size * 0.04));
        ctx.globalAlpha = c.alpha;
      }

      ctx.lineWidth = Math.max(4, size * 0.16);
      ctx.strokeStyle = '#000';
      ctx.strokeText(ch.ch, 0, 0);
      if (glow) {
        ctx.shadowColor = scary ? EMOTIONS.fear.glow : emo.glow;
        ctx.shadowBlur = 10 + 30 * I;
      }
      ctx.fillStyle = scary ? EMOTIONS.fear.color : emo.color;
      ctx.fillText(ch.ch, 0, 0);
      ctx.restore();
    }
  });
  ctx.restore();
}

function render(now, dt) {
  // 背景
  ctx.fillStyle = '#07070c';
  ctx.fillRect(0, 0, W, H);

  // 画面フラッシュ
  if (fx.flash > 0.005) {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, fx.flashColor);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = fx.flash;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    fx.flash *= 0.9;
  }

  ctx.save();
  // 画面の揺れ
  if (fx.shake > 0.3) {
    ctx.translate(jitter(fx.shake), jitter(fx.shake));
    fx.shake *= 0.88;
  }

  // 衝撃波
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.r += r.speed * dt;
    r.a *= 0.94;
    if (r.a < 0.02) {
      rings.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = r.a;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 6 + 10 * r.a;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 古い字幕から描いて、新しい字幕を上に
  const ordered = [...captions].sort((a, b) => a.born - b.born);
  for (const c of ordered) drawCaption(c, now);
  ctx.restore();

  // 下端の音量バー（聞いていることが分かるように）
  const color = liveCaption ? EMOTIONS[liveCaption.emotion].glow : '#6f8cff';
  const bw = W * features.volume;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.8;
  ctx.fillRect((W - bw) / 2, H - 4 - features.volume * 10, bw, 4 + features.volume * 10);
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

  const newestFirst = [...captions].sort((a, b) => b.born - a.born);
  newestFirst.forEach((c, rank) => c.update(now, rank));
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
  const emo = liveCaption ? liveCaption.emotion : captions.length ? captions[captions.length - 1].emotion : 'neutral';
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
    `<div class="row"><span class="label">認識</span><span>${running ? '● 聞き取り中' : '停止'}</span></div>`;
}

/* =========================================================
 * 起動・キー操作
 * ========================================================= */
async function start() {
  startBtn.disabled = true;
  // 字幕用フォントの読み込みを待つ（オフラインでも 2 秒で諦めて代替フォントで続行）
  await Promise.race([document.fonts.load(fontStr(64)), new Promise((r) => setTimeout(r, 2000))]);

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
