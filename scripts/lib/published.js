/**
 * 公開対象の店舗を判定する共有ロジック(build.js / fetch-place-ids.js / fetch-ratings.js が参照)。
 *
 * 【なぜ共有モジュールにするか】
 * 「どの店舗を公開し、どの店舗を公開しないか」は本サイトで最も守るべき制約。公開判定のコピーが
 * スクリプトごとに分散すると、片方だけ更新されて非公開のはずの店舗の評価を誤って取得・表示する
 * 事故につながる。そのため単一の真実の源としてここに集約する。
 *
 * ※ build.js は最終的な出力(dist)のゲートとして、ここの判定に加えて独自にも同じフィルタを
 *    かける多重防御になっている。fetch 系スクリプトも同じ判定を使うことで、そもそも非公開店の
 *    place_id・評価を取得しない(無料枠の無駄遣いも防ぐ)。
 */

// 一般公開する業態(カテゴリID)のallowlist。
//
// 【2026-07-30 変更】接待を伴う業態(スナック・キャバクラ・ラウンジ・クラブ・ガールズバー)を
// 公開対象に追加した。これらは 2026-07-17 以降「フェーズ2」として非公開扱い(データは
// data/venues.json に保持しつつページを一切生成しない)だったが、2026-07-30 に社長判断で
// 公開へ切り替えた。
//   - フェーズ2の解除条件として設定されていた2項目のうち、「削除依頼導線の実運用実績」は
//     2026-07-29 に充足した(CONTACT_FORM_URL の実フォーム化)。
//   - もう1項目の「弁護士確認」は、社長判断により waive された(実施していない)。
//   ※ 承認の経緯そのものは会社側の非公開記録に置く。ここには公開範囲の事実のみを記述する。
//
// これらの業態を公開するにあたり、対象カテゴリの店舗ページ・カテゴリページには年齢制限に関する
// 一般的な注意喚起を表示する(scripts/build.js の NIGHTLIFE_CATEGORIES / AGE_RESTRICTION_NOTICE)。
const PUBLISHED_CATEGORIES = [
  "bar",
  "izakaya",
  "concafe",
  "shisha",
  "poker",
  // --- 2026-07-30 追加(旧フェーズ2の業態) ---
  "snack",
  "kyabakura",
  "lounge",
  "club",
  "girlsbar",
];

// カテゴリは公開対象だが、店舗単位で非公開にするIDの集合。
//
// 【現在は空】2026-07-30 の公開範囲変更まで、次の4店が「カテゴリは公開対象だが実態は接待型」と
// いう理由で個別に非公開だった: izakaya-nyanko-sakaba / girlsbar-platinum-seven / girlsbar-axia /
// concafe-soul-one。接待を伴う業態そのものを公開対象にしたことで、この4店だけを非公開に保つ
// 根拠が無くなったため、いずれも公開した。
//   - girlsbar-axia / girlsbar-platinum-seven … 店名・公式サイトという店自身の名乗り(一次情報)が
//     「ガールズバー」を示しているため girlsbar へ再分類した。
//   - izakaya-nyanko-sakaba / concafe-soul-one … 店自身の名乗りに基づく一次情報が無く、当サイトが
//     業態を断定するのは避けるべきと判断し、現行カテゴリのまま公開した。
//   判断の根拠は data/venue-audit-log.md「2026-07-30(公開範囲の変更)」の節を参照。
//
// 【仕組みは残す】将来、個別の店舗を非公開にする必要が生じた場合(店舗様からの掲載辞退のご連絡、
// 掲載基準への不適合が判明した場合など)は、ここにIDを追加すれば dist・sitemap・検索・タグ・
// 一覧・JSON-LD のどこにも出なくなる。データ自体は data/venues.json に残せる。
const PHASE2_VENUE_IDS = new Set([
  // 2026-07-30: フェーズ2業態(スナック・キャバクラ等)は社長判断で公開に切り替えたが、
  // 次の店は「読者に表示できる出典が1件も無い」ため、当サイトの原則
  //(出典の無い店は掲載しない)に従って掲載を保留する。
  //
  // 経緯: 取り込み時の出典が求人媒体・出会い系メディア等、公開ページに出せない媒体のみだった。
  // それらは internalSources へ退避したため、表示できる出典が0件になった。
  // いずれも確度C(1系統のみ・営業実態も未確認)で、読者から見て検証手段が無い状態になる。
  // 公式サイト・公式SNS・地図サービス等、表示できる出典が1件でも取得できた時点で公開する。
  // 対象IDと未取得の理由は data/venue-audit-log.md に記録している。
  "kyabakura-nestia",
  "kyabakura-rudan",
  "kyabakura-vega",
  "club-ari",
  "club-kou",
  "lounge-ai-spaed",
  "lounge-zen",
  "snack-rion",
  "snack-70",
  "snack-reims",
  "snack-anew",
  "snack-pearl",
  "snack-berry",
  "girlsbar-8eight",
  "girlsbar-hrb",
  "girlsbar-pallas",
  "girlsbar-baccara",
  "girlsbar-bully",
  "girlsbar-family",
  // 確度Bだが、表示できる出典が取得できなかった店(2026-07-30 時点)。
  // 夜遊びショコラ・ナイツネット等の客向けポータルを横断したが掲載が見つからなかった。
  // 同じ理由で保留する。出典が1件でも取得できた時点で公開する。
  "girlsbar-s-cafe",
  // 2026-07-31: 上記7店(kyabakura-all / lounge-jewel / snack-amore /
  // girlsbar-all-new-ace / snack-en / snack-kokoro / snack-lavender)は、
  // 客向けポータル・地図サービス(求人媒体・出会い系メディアではない)で
  // 住所が一致する出典が見つかったため、sources に追加してここから外し公開した。
  // 詳細は data/venue-audit-log.md を参照。
  // 2026-07-31: スナックの Tier B(28店・出典独立2系統以上=B14 / 1系統のみ=C12)・
  // Tier C(59店・すべて確度C)を data/venues.json に取り込んだ(合計85店)。
  // これらは社長指示により「1店も公開しない」ことが取り込みの絶対条件だったため、
  // snack カテゴリが2026-07-30に公開対象へ切り替わっている現状にかかわらず、
  // 出典の表示可否(NON_PUBLISHABLE_SOURCE_RE)を問わず全店をここに登録して非公開を維持する。
  // 上記の既存パターン(出典0件の店のみ非公開)とは適用範囲が異なる点に注意。
  // 詳細は data/venue-audit-log.md「2026-07-31」の節を参照。
  "snack-minto", "snack-sachiko", "snack-ching", "snack-kirara",
  "snack-renge", "snack-mizuki", "snack-nostalgia", "snack-pman-house",
  "snack-canon", "snack-night-in-ashura", "snack-baru", "snack-new-entei",
  "snack-space-shuttle", "snack-yuko", "snack-tomoko", "snack-harbor",
  "snack-rumi", "snack-liberty", "snack-le-jardin", "snack-luminor",
  "snack-lotus", "snack-one-way", "snack-kosen", "snack-support",
  "snack-a-one", "snack-sayu", "snack-espace", "snack-grand-opera",
  "snack-croce", "snack-six", "snack-jusanya", "snack-tiara",
  "snack-parfum", "snack-dada", "snack-umeko", "snack-bouquet",
  "snack-members-michi", "snack-blue-tree", "snack-ikkoten", "snack-ei",
  "snack-sweetpea", "snack-members-k", "snack-mayumi", "snack-yui",
  "snack-diamond", "snack-misa", "snack-berie", "snack-espresso-ginnoyubiwa",
  "snack-noguera", "snack-nao", "snack-milky-way", "snack-night-in-yoko",
  "snack-my-way", "snack-new-lodge", "snack-denshobato", "snack-heartful-karen",
  "snack-ezaki", "snack-petit-devil", "snack-takako", "snack-hisashi",
  "snack-sudo-bar", "snack-mariko", "snack-alba", "snack-karin",
  "snack-partner", "snack-tenderly", "snack-human-love", "snack-art-nouveau",
  "snack-twist", "snack-di-on", "snack-gloss", "snack-emi",
  "snack-stand-jun", "snack-theory", "snack-toki", "snack-luxury",
  "snack-message", "snack-pair-flower", "snack-doruche", "snack-venus",
  "snack-kaze-no-oto", "snack-shell-room", "snack-rapport", "snack-maki",
  "snack-rotta",
]);

// 1店が公開対象か。
function isPublished(v) {
  return PUBLISHED_CATEGORIES.includes(v.category) && !PHASE2_VENUE_IDS.has(v.id);
}

// 公開対象の店舗だけに絞り込む。
function publishedVenues(allVenues) {
  return allVenues.filter(isPublished);
}

module.exports = { PUBLISHED_CATEGORIES, PHASE2_VENUE_IDS, isPublished, publishedVenues };
