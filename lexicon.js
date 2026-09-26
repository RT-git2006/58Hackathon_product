'use strict';

/* =========================================================
 * 語彙・フォント・配色の定義
 *  - 単語（文節）ごとに「カテゴリ」を推定し、フォント・配色・テロップの装飾を決める
 *  - 辞書に無い単語でも、含まれる漢字 1 文字ずつの意味（KANJI）から推定する
 * ========================================================= */

// 使う Google Fonts（ファミリー名: ウェイト）
const FONT_FAMILIES = {
  'Dela Gothic One': 400,
  'M PLUS Rounded 1c': 900,
  'Zen Maru Gothic': 900,
  'RocknRoll One': 400,
  'Rampart One': 400,
  'Train One': 400,
  'Reggae One': 400,
  'Potta One': 400,
  'Mochiy Pop One': 400,
  'Darumadrop One': 400,
  'Hachi Maru Pop': 400,
  'Yusei Magic': 400,
  'Kiwi Maru': 500,
  'Yuji Boku': 400,
  'Yuji Syuku': 400,
  'New Tegomin': 400,
  'Zen Antique': 400,
  'Kaisei Decol': 700,
  'Klee One': 600,
  'Zen Kurenaido': 400,
  'Yomogi': 400,
  'DotGothic16': 400,
  'Stick': 400,
};

/*
 * カテゴリごとの見た目
 *  fonts    : フォント候補（この中からランダム）
 *  styles   : テロップの装飾（telop=グラデ+白フチ+黒フチ / pop=白文字+色フチ / solid=単色+色フチ /
 *             horror=グリッチ / neon=光るフチ）
 *  palettes : [明るい色, 濃い色]
 *  emo      : 発話全体の感情推定への寄与
 */
const CATEGORIES = {
  neutral: {
    label: 'ふつう',
    fonts: ['M PLUS Rounded 1c', 'Zen Maru Gothic', 'RocknRoll One', 'Dela Gothic One', 'Mochiy Pop One'],
    styles: ['telop', 'telop', 'pop', 'solid'],
    palettes: [['#ffffff', '#a9c6ff'], ['#fff6a8', '#ffb300'], ['#b8f4ff', '#1fb6ff'], ['#ffd1e6', '#ff5ca3'],
      ['#d6ffc2', '#3fcf3a'], ['#ffe0b8', '#ff8a1f'], ['#e8d9ff', '#9b6bff']],
    emo: {},
  },
  fear: {
    label: '恐怖',
    fonts: ['Yuji Boku', 'New Tegomin', 'Zen Antique', 'Yuji Syuku'],
    styles: ['horror', 'horror', 'neon'],
    palettes: [['#f0e0ff', '#8a2be2'], ['#ff4a4a', '#6a0000'], ['#c8ffbf', '#1f8a1a']],
    emo: { fear: 1 },
  },
  surprise: {
    label: '驚き',
    fonts: ['Rampart One', 'Dela Gothic One', 'Train One', 'Reggae One'],
    styles: ['telop', 'pop', 'solid'],
    palettes: [['#fffb7d', '#ff9d00'], ['#8af8ff', '#0077ff'], ['#ffffff', '#ffcc00']],
    emo: { surprise: 1 },
  },
  joy: {
    label: '喜び',
    fonts: ['Mochiy Pop One', 'Darumadrop One', 'Rampart One', 'Hachi Maru Pop'],
    styles: ['telop', 'pop', 'solid'],
    palettes: [['#fff176', '#ff8a00'], ['#ffa6da', '#ff2d88'], ['#b4ff82', '#1fbf5b'], ['#9ff2ff', '#ff6ad5']],
    emo: { joy: 1 },
  },
  anger: {
    label: '怒り',
    fonts: ['Dela Gothic One', 'Reggae One', 'Potta One'],
    styles: ['solid', 'telop', 'pop'],
    palettes: [['#ff6a6a', '#b30000'], ['#ffc04d', '#ff2d00'], ['#ffffff', '#ff1a1a']],
    emo: { anger: 1 },
  },
  sad: {
    label: '悲しみ',
    fonts: ['Klee One', 'Zen Kurenaido', 'Yomogi'],
    styles: ['neon', 'telop'],
    palettes: [['#c4e8ff', '#1e6fd9'], ['#e4e4ff', '#6a7bd6'], ['#d9f7ff', '#3b9ecf']],
    emo: { sad: 1 },
  },
  love: {
    label: '好き・かわいい',
    fonts: ['Hachi Maru Pop', 'Yusei Magic', 'Kiwi Maru', 'Mochiy Pop One'],
    styles: ['pop', 'telop', 'neon'],
    palettes: [['#ffc1e3', '#ff3f98'], ['#ffe0fa', '#c84bff'], ['#fff0f5', '#ff6f91']],
    emo: { joy: 0.8 },
  },
  power: {
    label: 'パワー・爆発',
    fonts: ['Dela Gothic One', 'Potta One', 'Reggae One', 'Train One'],
    styles: ['solid', 'telop'],
    palettes: [['#ffee3d', '#ff3d00'], ['#ffffff', '#ff6a00'], ['#fff3a0', '#e0005a']],
    emo: { anger: 0.4, surprise: 0.5 },
  },
  cool: {
    label: 'かっこいい・ファンタジー',
    fonts: ['Yuji Syuku', 'Zen Antique', 'Kaisei Decol', 'Potta One'],
    styles: ['telop', 'neon', 'solid'],
    palettes: [['#fff2c2', '#c89200'], ['#e6f0ff', '#3a6bff'], ['#eadcff', '#6a1bd6'], ['#ffffff', '#00b3a4']],
    emo: { surprise: 0.3 },
  },
  food: {
    label: '食べ物',
    fonts: ['Mochiy Pop One', 'Kiwi Maru', 'Yusei Magic', 'Darumadrop One'],
    styles: ['pop', 'telop'],
    palettes: [['#ffe29a', '#ff7a00'], ['#ffd1a6', '#d8431a'], ['#fff5d6', '#b5651d']],
    emo: { joy: 0.5 },
  },
  nature: {
    label: '自然・生き物',
    fonts: ['Kaisei Decol', 'Zen Kurenaido', 'Klee One', 'Kiwi Maru'],
    styles: ['telop', 'pop'],
    palettes: [['#d0ffb8', '#2e9e44'], ['#b8ecff', '#1a8fd6'], ['#ffe0f0', '#e0609a']],
    emo: {},
  },
  tech: {
    label: 'デジタル・ゲーム',
    fonts: ['DotGothic16', 'Train One', 'Stick'],
    styles: ['neon', 'solid'],
    palettes: [['#8affc1', '#00a86b'], ['#9ad0ff', '#2757ff'], ['#ffffff', '#00d5ff']],
    emo: {},
  },
  funny: {
    label: 'おもしろ',
    fonts: ['Darumadrop One', 'Hachi Maru Pop', 'Rampart One', 'Yusei Magic'],
    styles: ['pop', 'solid', 'telop'],
    palettes: [['#fff66b', '#ff4fd0'], ['#aaffee', '#ff9f1a'], ['#ffffff', '#8c52ff']],
    emo: { joy: 1 },
  },
  sound: {
    label: '擬音',
    fonts: ['Dela Gothic One', 'Rampart One', 'Reggae One', 'Darumadrop One'],
    styles: ['solid', 'pop'],
    palettes: [['#ffffff', '#ff2e63'], ['#fff95e', '#ff00aa'], ['#7dfff1', '#7a2cff']],
    emo: { surprise: 0.4 },
  },
  katakana: {
    label: 'カタカナ語',
    fonts: ['Dela Gothic One', 'RocknRoll One', 'Train One', 'Rampart One'],
    styles: ['telop', 'pop'],
    palettes: [['#ffffff', '#ff7ab6'], ['#fff58a', '#ff6f00'], ['#aef6ff', '#4b7bff']],
    emo: {},
  },
};

// 単語 → カテゴリ（部分一致。長い単語ほど強く効く）
const WORDS = {
  fear: ['怖い', 'こわい', 'こわっ', 'コワイ', 'やば', 'ヤバ', 'おばけ', 'お化け', 'オバケ', 'ゾンビ', 'ゆうれい', '幽霊',
    'たすけて', '助けて', 'たすけ', 'にげ', '逃げ', 'ぎゃあ', 'ぎゃー', 'ギャー', 'ギャア', 'ひぃ', 'ヒィ', 'ひええ',
    'ホラー', 'ぶきみ', '不気味', 'ぞっと', 'ゾッと', 'ぞわ', 'ゾワ', 'SAN', '正気度', '発狂', 'ファンブル', 'いたい',
    'あぶな', 'きもちわる', 'キモ', 'グロ', 'しぬ', '死ぬ', 'しんだ', '死んだ', 'のろい', '呪い', 'たたり', '祟り',
    'かいぶつ', '怪物', 'クトゥルフ', '邪神', 'おそろし', '恐ろし', 'こわく', '悲鳴', 'ひめい', 'やめて', 'いや',
    'ちまみれ', '血まみれ', 'くらやみ', '暗闇', 'まっくら', '真っ暗', 'ゴースト', 'デス', 'ナイトメア'],
  surprise: ['えっ', 'えー', 'えぇ', 'ええっ', 'まじか', 'まじで', 'マジ', 'うそ', '嘘', 'ほんと', '本当', 'びっくり',
    'ビックリ', 'すご', 'スゴ', '凄', 'まさか', 'なんで', 'なんと', '信じられ', 'しんじられ', 'うわ', 'ウワ', 'おおっ',
    'おぉ', 'へえ', 'へぇ', 'わお', 'ワオ', 'いきなり', 'とつぜん', '突然', 'なにこれ', '何これ', 'はあ？', 'ええ？',
    'ありえな', 'あり得な', 'やっば', 'キタ', '出た', 'どういうこと', 'え？'],
  joy: ['うれし', '嬉し', 'たのし', '楽し', 'やった', 'ヤッタ', 'さいこう', '最高', 'ありがと', 'ありがとう',
    'おめでと', 'わーい', 'ワーイ', 'あはは', 'わはは', 'いいね', 'イイネ', '成功', 'せいこう', 'クリティカル',
    'よっしゃ', 'ヨッシャ', 'かんぺき', '完璧', 'すばらし', '素晴らし', 'わくわく', 'ワクワク', 'ハッピー',
    'ラッキー', 'らっきー', 'たのしみ', '楽しみ', 'ナイス', 'グッド', 'イェーイ', 'いえーい', 'やったー', '勝った',
    'かった！', 'できた', '出来た', 'いいじゃん', 'よかった', '良かった', 'すてき', '素敵', 'ばんざい', '万歳',
    'おつかれ', 'お疲れ', 'がんばろ', '頑張ろ', 'がんばれ', '頑張れ', 'ファイト', 'よろしく'],
  anger: ['おこって', '怒って', 'むかつ', 'ムカつ', 'ムカ', 'ふざけ', 'いいかげん', 'いい加減', 'うるさ', 'うるせ',
    'ゆるさ', '許さ', 'なんだと', 'ばかやろ', 'バカ', '馬鹿', 'あほ', 'アホ', 'くそ', 'クソ', 'ちくしょう', '畜生',
    'イライラ', 'いらいら', 'キレ', 'だまれ', '黙れ', 'ざけんな', 'なめんな', 'ぶっとば', 'ぶっ飛ば', 'ぶっころ',
    'いいかげんにし', 'ゴラ', 'ごら', 'こらっ', 'コラ', 'ちがう', '違う', 'だめ', 'ダメ'],
  sad: ['かなし', '悲し', 'さみし', '寂し', 'さびし', 'つらい', '辛い', 'ないた', '泣い', 'しょんぼり', 'ショック',
    'ざんねん', '残念', 'がっかり', 'ガッカリ', 'くやし', '悔し', 'むなし', '虚し', 'ごめん', 'すみません',
    'さようなら', 'さよなら', 'バイバイ', 'せつな', '切な', '失敗', 'しっぱい', '負け', 'まけた', 'つかれた',
    '疲れた', 'しんどい', 'だるい', 'おちこ', '落ち込', 'ひとりぼっち', 'なみだ', '涙'],
  love: ['すき', '好き', 'だいすき', '大好き', 'あいしてる', '愛してる', 'こいびと', '恋人', 'かわい', '可愛',
    'カワイイ', 'ラブ', 'きゅん', 'キュン', 'ドキドキ', 'どきどき', 'デート', 'ハート', 'もえ', '萌え', 'てれる',
    '照れ', 'きれい', '綺麗', 'キレイ', 'うつくし', '美し', 'イケメン', 'かっわ', 'ちゅー', 'ぎゅー', 'ハグ'],
  power: ['ドカン', 'どかん', 'バーン', 'ばーん', 'ドーン', 'どーん', '爆発', 'ばくはつ', 'ボーン', 'ズドン', 'ガツン',
    'パワー', 'マックス', 'MAX', '全力', 'ぜんりょく', 'フルパワー', '必殺', 'ひっさつ', 'こうげき', '攻撃', 'ダメージ',
    'ぶっ壊', 'こわれ', '壊れ', 'ぶちかま', 'いくぞ', '行くぞ', 'くらえ', '食らえ', 'うおお', 'ウオオ', 'おりゃ',
    'オラ', 'とりゃ', 'せいっ', 'ファイヤー', 'ファイア', 'サンダー', 'ビーム', 'ロケット', 'ミサイル'],
  cool: ['かっこい', 'カッコい', 'かっけ', 'カッケ', '格好い', 'クール', 'ヒーロー', '勇者', 'まほう', '魔法',
    'ドラゴン', 'ダンジョン', 'モンスター', 'ボス', '伝説', 'でんせつ', '運命', 'うんめい', '冒険', 'ぼうけん', '騎士',
    'ファンタジー', 'ステータス', 'スキル', 'レベル', '呪文', 'ダイス', 'さいころ', 'サイコロ', '判定', '探索者',
    'キーパー', 'シナリオ', 'セッション', 'キャラクター', 'キャラ', 'ロールプレイ', 'TRPG', 'ゲームマスター', 'GM',
    'KP', 'NPC', 'ラスボス', '世界', 'せかい', '宇宙', 'うちゅう', '未来', 'みらい', '魔王', 'エルフ', 'ナイト',
    'ソード', 'マジック', 'ミステリー', '謎', 'なぞ', '秘密', 'ひみつ', '真実', 'しんじつ'],
  food: ['たべ', '食べ', 'おいし', '美味し', 'うまい', 'ウマい', 'ごはん', 'ご飯', 'ラーメン', 'カレー', 'すし', '寿司',
    'ピザ', 'ケーキ', 'おなか', 'お腹', 'はらへ', '腹減', 'のみもの', '飲み', 'ビール', 'おかし', 'お菓子', 'チョコ',
    'アイス', 'パンケーキ', 'やきにく', '焼肉', 'コーヒー', 'ジュース', 'たこやき', 'たこ焼き', 'お好み焼き',
    'おこのみやき', 'うどん', 'そば', 'おにぎり', 'からあげ', '唐揚げ', 'ハンバーガー', 'ポテト', 'スイーツ',
    'いただきます', 'ごちそうさま', 'もぐもぐ', 'ぱくぱく', 'おやつ', 'ランチ', 'ディナー'],
  nature: ['たいよう', '太陽', 'ねこ', 'ネコ', 'いぬ', 'イヌ', 'さくら', 'サクラ', 'もみじ', 'にじ', 'そよかぜ',
    'ゆきだるま', 'かみなり', 'たいふう', '台風', 'じしん', '地震', 'ほしぞら', '星空', 'うさぎ', 'パンダ', 'ペンギン',
    'きつね', 'たぬき', 'くま', 'ことり', '小鳥', 'はなび', '花火', 'しぜん', '自然', 'てんき', '天気'],
  tech: ['パソコン', 'スマホ', 'ゲーム', 'プログラム', 'プログラミング', 'コード', 'AI', 'ロボット', 'データ',
    'アプリ', 'ネット', 'インターネット', 'コンピュータ', 'バグ', 'エラー', 'ハッカソン', 'マイク', 'カメラ',
    'プロジェクター', 'WiFi', 'Wi-Fi', 'サーバー', 'クラウド', 'アルゴリズム', 'ピクセル', 'ドット', 'ブラウザ',
    'システム', 'デバッグ', 'ハッカー', 'サイバー', 'デジタル', 'センサー'],
  funny: ['www', 'ｗｗ', 'ww', '笑', 'わらわら', 'わろた', 'ワロタ', 'ウケる', 'うける', 'おもしろ', '面白', 'ギャグ',
    'ボケ', 'ツッコミ', 'なんでやねん', 'あほくさ', 'ネタ', 'オチ', 'ふふ', 'ぷぷ', 'くすくす', 'げらげら', 'ゲラゲラ',
    'ウケ', 'ばかうけ', 'ちょける', 'しょーもな', 'しょうもな', 'ほんまに', 'あかん', 'めっちゃ', 'ええやん'],
};

// 漢字 1 文字 → カテゴリ（辞書に無い単語でも、漢字の意味から見た目を決めるため）
const KANJI = {
  fear: '怖恐死殺血闇霊鬼呪怨骸屍墓葬幽獄悪毒狂惨凶禍骨亡腐蝕妖怪祟危険警震慄叫襲喰牙棺影冥邪災罠傷痛病',
  surprise: '驚愕奇突急仰天唖怪異変謎',
  joy: '喜楽嬉祝幸福祭歓遊勝優賞宴満笑賑輝希望夢晴恵',
  anger: '怒憤激罵叱恨憎嫌殴罰敵憤怨暴荒',
  sad: '悲泣涙哀寂孤別失敗辛苦嘆惜憂鬱喪去散枯弱虚',
  love: '愛恋好婚嫁姫萌抱恋麗美媛妹姉嬢',
  power: '爆炎火雷撃破壊砲拳力強猛烈轟燃熱炸裂弾銃闘斬突衝撃砕',
  cool: '剣刀槍盾鎧騎士神王竜龍魔法術聖翼覇英雄勇戦兵軍城宝冒険星宙宇界運命銀黄金紋章',
  food: '食飯肉魚米麺酒茶菓甘味寿司鍋焼餅卵野菜果苺桃飲腹糖塩油粉汁丼',
  nature: '花桜木森林山川海空雨雪風雲虹月草葉鳥犬猫虫馬熊狐狸兎蝶岩湖波光陽',
  tech: '電機械算数値計科技網線画像機器装置信号解析',
};

// ---------- 分類処理 ----------
const KANJI_MAP = new Map();
for (const [cat, chars] of Object.entries(KANJI)) {
  for (const ch of chars) if (!KANJI_MAP.has(ch)) KANJI_MAP.set(ch, cat);
}
const WORD_LIST = [];
for (const [cat, words] of Object.entries(WORDS)) for (const w of words) WORD_LIST.push([w, cat]);

const RE_KATAKANA = /^[゠-ヿー・！？!?]+$/;
// ドキドキ・ゴゴゴ・わくわく のような繰り返しの擬音
const RE_SOUND = /^([ぁ-ヿ]{1,3})\1+[っッーぁ-ぉァ-ォ！!]*$/;
const RE_NUMBER = /[0-9０-９]/;

const classifyCache = new Map();

function classifyChunk(text) {
  if (classifyCache.has(text)) return classifyCache.get(text);
  const score = {};
  const add = (cat, v) => (score[cat] = (score[cat] || 0) + v);
  for (const [w, cat] of WORD_LIST) {
    if (text.includes(w)) add(cat, 2 + w.length);
  }
  for (const ch of text) {
    const cat = KANJI_MAP.get(ch);
    if (cat) add(cat, 1.5);
  }
  if (RE_SOUND.test(text)) add('sound', 3);

  let best = null;
  let bestScore = 0;
  for (const [cat, v] of Object.entries(score)) {
    if (v > bestScore) {
      best = cat;
      bestScore = v;
    }
  }
  if (!best) {
    if (RE_NUMBER.test(text)) best = 'tech';
    else if (text.length >= 2 && RE_KATAKANA.test(text)) best = 'katakana';
    else best = 'neutral';
  }
  classifyCache.set(text, best);
  return best;
}
