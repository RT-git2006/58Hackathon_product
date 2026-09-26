// Unicode CLDR の日本語絵文字キーワードから、「単語 → 絵文字」の対応表 emoji-ja.js を作る
//   node tools/build-emoji-ja.js
// データ: CLDR annotations (Unicode License v3) https://github.com/unicode-org/cldr-json
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = '48.2.0';
const URL = `https://cdn.jsdelivr.net/npm/cldr-annotations-full@${VERSION}/annotations/ja/annotations.json`;

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

// Windows 11 の Segoe UI Emoji などで表示できない新しい絵文字（Emoji 15 以降）は使わない。
// U+1FA70–1FAFF のブロックは、Emoji 14 までに割り当てられた範囲だけ許可する
const ALLOWED_1FA = [[0x70, 0x74], [0x78, 0x7c], [0x80, 0x86], [0x90, 0xac], [0xb0, 0xba], [0xc0, 0xc5], [0xd0, 0xd9], [0xe0, 0xe7], [0xf0, 0xf6]];
// Emoji 15.1 の合成絵文字（首振り・ライム・不死鳥・切れた鎖 など）に使われる部品
const NEW_PARTS = [0x2194, 0x2195, 0x1f7e9, 0x1f7eb, 0x1f525, 0x1f4a5];

function displayable(emoji) {
  const cps = [...emoji].map((c) => c.codePointAt(0));
  if (emoji.includes(ZWJ) && cps.some((cp) => NEW_PARTS.includes(cp))) return false;
  return cps.every((cp) => cp < 0x1fa70 || cp > 0x1faff || ALLOWED_1FA.some(([a, b]) => cp - 0x1fa00 >= a && cp - 0x1fa00 <= b));
}

async function main() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`${res.status} ${URL}`);
  const json = await res.json();
  const ann = json.annotations.annotations;

  const byWord = new Map(); // 単語 → 絵文字の候補 [{ emoji, tts, n }]
  for (const [emoji, a] of Object.entries(ann)) {
    if (!displayable(emoji)) continue;
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
  const out = {};
  for (const [w, list] of byWord) {
    list.sort((a, b) => score(a, w) - score(b, w));
    // 名前に単語を含む絵文字が無く、候補が多すぎる単語は、意味が広すぎるので捨てる
    if (score(list[0], w) >= 1000 && list.length > 6) continue;
    out[w] = list[0].emoji;
  }
  const keys = Object.keys(out).sort();
  const body = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`).join('\n');
  const file = `// 自動生成: node tools/build-emoji-ja.js（手で編集しない）
// 出典: Unicode CLDR ${VERSION} annotations (ja) — Unicode License v3 https://www.unicode.org/license.txt
'use strict';

// 日本語の単語 → 絵文字（${keys.length} 語）
const CLDR_EMOJI_JA = {
${body}
};
`;
  fs.writeFileSync(path.join(__dirname, '..', 'emoji-ja.js'), file);
  console.log(`emoji-ja.js: ${keys.length} words`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
