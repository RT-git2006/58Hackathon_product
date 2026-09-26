// Unicode CLDR の日本語絵文字キーワードと Unicode の絵文字分類から、emoji-ja.js を作る
//   node tools/build-emoji-ja.js
//   - CLDR_EMOJI_JA  : 日本語の単語 → 絵文字
//   - CLDR_EMOJI_CAT : 絵文字 → 字幕のカテゴリ（lexicon.js の CATEGORIES。辞書に無い単語の雰囲気判定に使う）
//   - CLDR_EMOJI_FACE: 顔・ハートなど「気分」を表す絵文字（話題の要約では控えめに扱う）
// データ: Unicode CLDR annotations / emoji-test.txt (Unicode License v3)
'use strict';

const fs = require('fs');
const path = require('path');

const CLDR_VERSION = '48.2.0';
const EMOJI_VERSION = '16.0';
const CLDR_URL = `https://cdn.jsdelivr.net/npm/cldr-annotations-full@${CLDR_VERSION}/annotations/ja/annotations.json`;
const TEST_URL = `https://unicode.org/Public/emoji/${EMOJI_VERSION}/emoji-test.txt`;
// Windows 11 の Segoe UI Emoji などで表示できるのは、おおむね Emoji 14.0 まで
const MAX_EMOJI_VERSION = 14.0;

// 意味が広すぎて、どの絵文字にするか決められない単語
const GENERIC = new Set([
  '顔', '人', '手', '動物', '食べ物', '飲み物', '記号', 'マーク', '体', '男', '女', '男性', '女性', '大人', '子ども', '子供',
  'ボタン', '矢印', '時計', '旗', '色', '服', '乗り物', '建物', '場所', '天気', '植物', '道具', '家', '目', '口', '鼻', '耳',
  '上', '下', '左', '右', '中', '大', '小', '日', '月', '年', '時', '分', '本', '語', '文字', '字', '物', '形', '線', '点',
  '指', 'ジェスチャー', '感情', '気持ち', '表情', 'スマイリー', '絵文字', 'サイン', '印', '四角', '丸', '三角', '白', '黒',
]);
const RE_HIRA = /^[ぁ-ゟー]+$/;
const RE_KANJI1 = /^[一-鿿]$/;
const ZWJ = '‍';
const strip = (e) => e.replace(/️/g, '');

// 絵文字の分類（subgroup）→ 字幕のカテゴリ
const SUBGROUP_CAT = {
  'face-smiling': 'joy', 'face-affection': 'love', 'face-tongue': 'funny', 'face-sleepy': 'sad', 'face-unwell': 'sad',
  'face-hat': 'joy', 'face-glasses': 'cool', 'face-concerned': 'sad', 'face-negative': 'anger', 'face-costume': 'fear',
  'cat-face': 'love', 'monkey-face': 'funny', heart: 'love', 'person-fantasy': 'cool', 'person-sport': 'power', family: 'love',
  'animal-mammal': 'nature', 'animal-bird': 'nature', 'animal-amphibian': 'nature', 'animal-reptile': 'nature',
  'animal-marine': 'nature', 'animal-bug': 'nature', 'plant-flower': 'nature', 'plant-other': 'nature',
  'food-fruit': 'food', 'food-vegetable': 'food', 'food-prepared': 'food', 'food-asian': 'food', 'food-sweet': 'food',
  drink: 'food', dishware: 'food', 'place-geographic': 'nature', 'place-religious': 'cool', 'sky & weather': 'nature',
  'transport-ground': 'tech', 'transport-water': 'tech', 'transport-air': 'tech', event: 'joy', 'award-medal': 'joy',
  sport: 'power', game: 'tech', music: 'joy', 'musical-instrument': 'joy', phone: 'tech', computer: 'tech',
  'light & video': 'tech', money: 'joy', tool: 'power', science: 'tech', medical: 'sad',
};
// 分類だけでは合わない絵文字
const OVERRIDE_CAT = {
  '😮': 'surprise', '😯': 'surprise', '😲': 'surprise', '😳': 'surprise', '🤯': 'surprise', '😨': 'fear', '😰': 'fear',
  '😱': 'fear', '😖': 'fear', '💥': 'power', '💢': 'anger', '💯': 'joy', '💤': 'sad', '🔪': 'fear', '🪓': 'fear',
  '🗡': 'cool', '⚔': 'cool', '🛡': 'cool', '💣': 'power', '⚰': 'fear', '⚱': 'fear', '🧟': 'fear', '🧛': 'fear',
  '👻': 'fear', '💀': 'fear', '☠': 'fear', '🎃': 'fear', '👹': 'fear', '👺': 'fear', '🔥': 'power', '⚡': 'power',
  '🌋': 'power', '🎉': 'joy', '🎊': 'joy', '😂': 'funny', '🤣': 'funny', '💔': 'sad', '🕯': 'fear', '🩸': 'fear',
  '🌧': 'sad', '☔': 'sad', '🌩': 'fear', '🌪': 'power', '🌈': 'joy', '☀': 'joy', '🎲': 'cool', '🔮': 'cool', '🪄': 'cool',
};
const FACE_SUBGROUPS = new Set(['face-smiling', 'face-affection', 'face-tongue', 'face-hand', 'face-neutral-skeptical',
  'face-sleepy', 'face-unwell', 'face-hat', 'face-glasses', 'face-concerned', 'face-negative', 'cat-face', 'monkey-face',
  'heart', 'emotion', 'hand-fingers-open', 'hand-fingers-partial', 'hand-single-finger', 'hand-fingers-closed', 'hands',
  'person-gesture']);

// emoji-test.txt: 絵文字 → { subgroup, version }
function parseEmojiTest(text) {
  const info = new Map();
  let subgroup = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('# subgroup:')) subgroup = line.slice(11).trim();
    const m = line.match(/^[0-9A-F ]+;\s*(fully-qualified|minimally-qualified|unqualified)\s*#\s*(\S+)\s+E(\d+\.\d+)/);
    if (m) info.set(strip(m[2]), { subgroup, version: parseFloat(m[3]) });
  }
  return info;
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

async function main() {
  const ann = (await (await fetchOk(CLDR_URL)).json()).annotations.annotations;
  const info = parseEmojiTest(await (await fetchOk(TEST_URL)).text());

  const byWord = new Map(); // 単語 → 絵文字の候補 [{ emoji, tts, n }]
  const cat = {};
  const faces = [];
  for (const [emoji, a] of Object.entries(ann)) {
    const inf = info.get(strip(emoji));
    if (!inf || inf.version > MAX_EMOJI_VERSION) continue; // 表示できない新しい絵文字は使わない
    const c = OVERRIDE_CAT[strip(emoji)] || SUBGROUP_CAT[inf.subgroup];
    if (c) cat[strip(emoji)] = c;
    if (FACE_SUBGROUPS.has(inf.subgroup)) faces.push(strip(emoji));
    const tts = (a.tts || [])[0] || '';
    const words = a.default || [];
    for (const raw of words) {
      const w = raw.trim();
      if (!w || GENERIC.has(w)) continue;
      if (w.length === 1 && !RE_KANJI1.test(w)) continue; // 1 文字は漢字だけ
      if (RE_HIRA.test(w) && w.length <= 2) continue; // 短いひらがなは誤爆しやすい
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push({ emoji, tts, n: words.length });
    }
  }

  // 候補の選び方: 名前（tts）と一致 > 名前に単語を含む（名前が短い順）> 合成でない・キーワードが少ない（意味がはっきりした）絵文字
  const composite = (e) => e.includes(ZWJ) || [...e].length > 2;
  const score = (c, w) => {
    if (c.tts === w) return 0;
    if (c.tts.includes(w)) return 100 + c.tts.length + (composite(c.emoji) ? 50 : 0);
    return 1000 + c.n + (composite(c.emoji) ? 500 : 0);
  };
  const words = {};
  for (const [w, list] of byWord) {
    list.sort((a, b) => score(a, w) - score(b, w));
    // 名前に単語を含む絵文字が無く、候補が多すぎる単語は、意味が広すぎるので捨てる
    if (score(list[0], w) >= 1000 && list.length > 6) continue;
    words[w] = list[0].emoji;
  }

  const obj = (o) =>
    Object.keys(o)
      .sort()
      .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(o[k])},`)
      .join('\n');
  const file = `// 自動生成: node tools/build-emoji-ja.js（手で編集しない）
// 出典: Unicode CLDR ${CLDR_VERSION} annotations (ja), Unicode emoji-test.txt ${EMOJI_VERSION} — Unicode License v3 https://www.unicode.org/license.txt
'use strict';

// 日本語の単語 → 絵文字（${Object.keys(words).length} 語）
const CLDR_EMOJI_JA = {
${obj(words)}
};

// 絵文字 → 字幕のカテゴリ（${Object.keys(cat).length} 個）
const CLDR_EMOJI_CAT = {
${obj(cat)}
};

// 顔・ハート・手ぶりなど「気分」を表す絵文字（話題の要約では控えめに扱う）
const CLDR_EMOJI_FACE = ${JSON.stringify(faces.join(''))};
`;
  fs.writeFileSync(path.join(__dirname, '..', 'emoji-ja.js'), file);
  console.log(`emoji-ja.js: ${Object.keys(words).length} words, ${Object.keys(cat).length} categorized emoji, ${faces.length} faces`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
