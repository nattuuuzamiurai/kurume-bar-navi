/**
 * 公式サイトロゴの登録データ(build.js / fetch-ratings.js が参照する単一の真実の源)。
 *
 * 【なぜ共有モジュールにするか】
 * 「どの店に公式ロゴがあるか」は、ロゴなし店(=ネームタイル or Google写真)を判定する基準になる。
 * build.js は表示の最終ゲートとしてこの一覧で「公式ロゴ→ホットペッパーlogo→Google写真→ネームタイル」の
 * 優先順位を決め、fetch-ratings.js は「公式ロゴもホットペッパーlogoも無いロゴなし店だけ」に
 * Google店舗写真を取りに行く対象を絞るためにこの一覧を使う。両者で定義がずれると、
 * 公式ロゴがある店に無駄に写真APIを叩く(無料枠の浪費)などの不整合が起きるため、ここに集約する。
 *
 * 【方針・制約(build.js のコメントより)】
 * - 使うのは「店自身(またはそのチェーン運営元)の公式サイト」に掲載されているロゴのみ。
 *   第三者グルメサイト(食べログ・ホットペッパー・Retty・ぐるなび)およびそのページ作成
 *   サービス(owst.jp / gorp.jp / r-corona.jp)由来の画像は一切使わない。
 * - 画像は自サイトに保存(rehost)せず、店のサーバー上のURLを直接参照する <img>(ホットリンク)。
 * - bg: "light"(既定=白背景)/ "dark"(濃色背景。白抜き・透過ロゴ向け)。
 */
const VENUE_LOGOS = {
  // --- 公式サイトロゴ 自動拡充(2026-07-27) ---
  "bar-141saketen": {
    imageUrl: "https://www.141saketen-kurume.com/wp-content/uploads/2023/04/logo-1.png",
    siteLabel: "141酒店 公式サイト",
    siteUrl: "https://www.141saketen-kurume.com/",
  },
  "izakaya-kushi-tanaka": {
    imageUrl: "https://restaurant.kushi-tanaka.com/images/logo.png",
    siteLabel: "串カツ田中 公式サイト",
    siteUrl: "https://restaurant.kushi-tanaka.com/detail/1220",
  },
  "izakaya-todoit": {
    imageUrl: "https://fancicalcafeandbar-todoit.com/img/main_logo.png",
    siteLabel: "to do it. -つどい- 公式サイト",
    siteUrl: "https://fancicalcafeandbar-todoit.com/",
  },
  "izakaya-tashu": {
    imageUrl: "https://static.wixstatic.com/media/8273ba_97ff1a8736c24ce2a2532c9e40868346~mv2.png",
    siteLabel: "もつ鍋 田しゅう 公式サイト",
    siteUrl: "https://www.motsunabe-tashu.com/",
  },
  "izakaya-kawakko": {
    imageUrl: "https://static.wixstatic.com/media/acc18a_aa89a1f222f94998a094f34be4311435~mv2.png/v1/fill/w_299,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/top_logo.png",
    siteLabel: "とりかわ博多かわっこ 公式サイト",
    siteUrl: "https://www.kawakko.com/",
  },
  "izakaya-tsukasa": {
    imageUrl: "https://kurume-yakitori-tsukasa.com/img/logo.png",
    siteLabel: "久留米焼鳥 つかさ 公式サイト",
    siteUrl: "https://kurume-yakitori-tsukasa.com/",
  },
  "izakaya-hamada": {
    imageUrl: "https://kushino-utage-hamada.com/system_panel/uploads/images/hd_logo.png",
    siteLabel: "串乃宴 はま田 公式サイト",
    siteUrl: "https://kushino-utage-hamada.com/",
  },
  "izakaya-hanhan": {
    imageUrl: "https://yakiniku-hanhan.com/struct/wp-content/uploads/logo.png",
    siteLabel: "炭火焼肉 絆繁 公式サイト",
    siteUrl: "https://yakiniku-hanhan.com/",
  },
  // --- 居酒屋・料理系 ---
  "izakaya-kakomian": {
    imageUrl: "https://momo.cmosite.com/wp-content/uploads/sites/35/2020/01/logo_w.png",
    siteLabel: "かこみ庵 久留米店 公式サイト",
    siteUrl: "https://bb-kakomian.com/kurume/",
  },
  "izakaya-kiseki-tebasaki": {
    imageUrl: "https://kiseteba.com/img/apple-touch-icon.png",
    siteLabel: "奇跡の手羽先 公式サイト",
    siteUrl: "https://kiseteba.com/",
  },
  "izakaya-torimero": {
    imageUrl: "https://torimero.com/prd/wp/wp-content/uploads/2025/05/torimero512.png",
    siteLabel: "三代目 鳥メロ 公式サイト",
    siteUrl: "https://torimero.com/nishitetsukurume/",
  },
  "izakaya-sumibi-sakagura-kita": {
    imageUrl: "https://www.sumibishuzo-kita.com/shared/img/shared/logo.png",
    siteLabel: "炭火酒蔵 喜多 公式サイト",
    siteUrl: "https://www.sumibishuzo-kita.com/",
  },
  "izakaya-sengoku-ieyasu": {
    imageUrl: "https://yakitori-ieyasu.co.jp/wp-content/uploads/2019/04/logo.png",
    siteLabel: "戦国焼鳥 家康 公式サイト",
    siteUrl: "https://yakitori-ieyasu.co.jp/",
  },
  "izakaya-kuimonoya-wan": {
    // 白抜きの筆文字ロゴ(透過PNG)のため濃色背景。
    imageUrl: "https://www.oizumifoods.co.jp/img/common/shops/izakaya_logo01.png",
    siteLabel: "くいもの屋わん 公式サイト(大泉フーズ)",
    siteUrl: "https://search.oizumifoods.co.jp/detail/2583/",
    bg: "dark",
  },
  "izakaya-isomaru": {
    imageUrl: "https://isomaru.jp/wp-content/uploads/2022/11/isomarusuisan_logo.jpg",
    siteLabel: "磯丸水産 公式サイト",
    siteUrl: "https://isomaru.jp/1541/",
  },
  "izakaya-sanzoku-dining": {
    imageUrl: "https://www.dragoncafe.jp/shared/img/shared/logo.png",
    siteLabel: "SANZOKU DINING さっさん 公式サイト",
    siteUrl: "https://www.dragoncafe.jp/",
  },
  "izakaya-sumibi-kushiya": {
    imageUrl: "https://new-hakata-style.com/assets/img/apple-touch-icon.png",
    siteLabel: "ニューハカタスタイル 公式サイト",
    siteUrl: "https://new-hakata-style.com/",
  },
  "izakaya-taketora": {
    imageUrl: "https://hakata-gyoza-taketora.com/wp-content/uploads/2026/02/cropped-2026_02_12_0lb_Kleki_transparent-180x180.png",
    siteLabel: "博多一口餃子たけとら 公式サイト",
    siteUrl: "https://hakata-gyoza-taketora.com/",
  },
  "izakaya-toriichizu": {
    // 白抜きの鶏マーク(透過PNG)のため濃色背景。
    imageUrl: "https://toriichizu.net/wp-content/uploads/2020/12/cropped-logo-toriichizu-180x180.png",
    siteLabel: "とりいちず 公式サイト",
    siteUrl: "https://toriichizu.net/shoplist/fukuoka/kurumeshi/",
    bg: "dark",
  },
  "izakaya-shanghai-shuka": {
    // 白抜きの店名ロゴ(透過PNG)のため濃色背景。
    imageUrl: "https://shanghai-shuka.com/img/logo_footer.png",
    siteLabel: "上海酒家 公式サイト",
    siteUrl: "https://shanghai-shuka.com/",
    bg: "dark",
  },
  "izakaya-ryuoukan-honten": {
    imageUrl: "https://static.wixstatic.com/media/b86d6d_0c42461f10d74c13b7775778ef59a210~mv2.png",
    siteLabel: "焼肉龍王館 公式サイト",
    siteUrl: "https://www.ryuoukan.com/",
  },
  "izakaya-okinawa-kizuna": {
    imageUrl: "https://kizuna1110.com/system_panel/uploads/touchicon/touchicon.png",
    siteLabel: "沖縄風居酒屋 絆 公式サイト",
    siteUrl: "https://kizuna1110.com/",
  },
  "izakaya-mui": {
    imageUrl: "https://www.yakiniku-mui.com/shared/img/shared/logo.png",
    siteLabel: "韓国家庭料理 無為 公式サイト",
    siteUrl: "https://www.yakiniku-mui.com/",
  },
  "izakaya-amenita-pizzeria": {
    imageUrl: "https://pizzeria-amenita.com/wp-content/themes/bonse/assets/images/logo.png",
    siteLabel: "Pizzeria Amenita 公式サイト",
    siteUrl: "https://pizzeria-amenita.com/",
  },
  "izakaya-hirukara-shinkichi": {
    imageUrl: "https://shinkichi-kurume.jp/system_panel/uploads/images/fft_logo02.png",
    siteLabel: "昼カラ酒場しん吉 公式サイト",
    siteUrl: "https://shinkichi-kurume.jp/shinkichi",
  },
  "izakaya-kalbi-yokocho": {
    imageUrl: "https://karubiyokotyo.com/img/logo_footer.png",
    siteLabel: "久留米焼肉 カルビ横丁 公式サイト",
    siteUrl: "https://karubiyokotyo.com/",
  },
  "izakaya-tori-shiki": {
    imageUrl: "https://torishiki-kurume.com/img/apple-touch-icon.png",
    siteLabel: "焼き鳥とり四季 公式サイト",
    siteUrl: "https://torishiki-kurume.com/",
  },
  "izakaya-shiroichi": {
    // 原寸(1400x1461・約930KB)は表示サイズに対し過大なため、Wix標準のリサイズ済みURL
    // (アスペクト比はほぼ同じ 240x250、約55KB)を参照する。実測 200 + image/png。
    imageUrl: "https://static.wixstatic.com/media/c62334_eb94ec85033a42bc8b5d8ce68dbcbd8e~mv2_d_1400_1461_s_2.png/v1/fill/w_240,h_250,al_c,q_85/c62334_eb94ec85033a42bc8b5d8ce68dbcbd8e~mv2_d_1400_1461_s_2.png",
    siteLabel: "ホルモン家 しろ壱 公式サイト",
    siteUrl: "https://www.horumonya-shiroichi.com/",
  },
  "izakaya-karisamu": {
    imageUrl: "https://izzy.best/images/karisamu/kasamu_a.png",
    siteLabel: "カリサム 公式サイト",
    siteUrl: "https://izzy.best/karisamu/index.html",
  },
  // --- コンカフェ ---
  "concafe-axia": {
    imageUrl: "https://anisongaxia.com/common/upload_data/anisongaxiacom/image/apple-touch-icon.png",
    siteLabel: "コンセプトカフェ AXIA 公式サイト",
    siteUrl: "https://anisongaxia.com/",
  },
  "concafe-platinum-seven": {
    imageUrl: "https://kurume-seven.com/wp-content/uploads/2026/05/favicon-200x200.png",
    siteLabel: "カフェラウンジ PLATINUM SEVEN 公式サイト",
    siteUrl: "https://kurume-seven.com/",
  },
  // --- バー ---
  "bar-remember": {
    imageUrl: "https://static.wixstatic.com/media/d671d7_b6cf8175b8d54a8a886dbc8580952a06%7Emv2.png/v1/fill/w_180%2Ch_180%2Clg_1%2Cusm_0.66_1.00_0.01/d671d7_b6cf8175b8d54a8a886dbc8580952a06%7Emv2.png",
    siteLabel: "リメンバー 公式サイト",
    siteUrl: "https://www.kurume-remember.com/",
  },
  "bar-manuka": {
    // 白抜き版(manuqa-logo-white.png)は白背景で不可視のため、正方形マークの favicon を採用。
    imageUrl: "https://manuqa.jp/wp-content/themes/manuqa-theme/favicon.png",
    siteLabel: "マヌーカ 公式サイト",
    siteUrl: "https://manuqa.jp/",
  },
  "bar-oshu-kitchen-alma": {
    imageUrl: "https://oshukitchen-alma.com/img/apple-touch-icon.png",
    siteLabel: "欧州キッチンアルマ 公式サイト",
    siteUrl: "https://oshukitchen-alma.com/",
  },
  "bar-live-actor": {
    imageUrl: "https://livebaractor.com/wp-content/uploads/2021/11/cropped-icon-180x180.png",
    siteLabel: "Live Bar Actor 公式サイト",
    siteUrl: "https://livebaractor.com/",
  },
  "bar-highball-stand": {
    imageUrl: "https://highball-stand.com/wp-content/uploads/2024/07/cropped-logo1-180x180.png",
    siteLabel: "ザ・ハイボールスタンド 公式サイト",
    siteUrl: "https://highball-stand.com/",
  },
  "bar-welmona": {
    imageUrl: "https://welmona.com/img/apple-touch-icon.png",
    siteLabel: "BAR WELMONA 公式サイト",
    siteUrl: "https://welmona.com/",
  },
  "bar-aletta": {
    imageUrl: "https://aletta-kurume.com/home/wp-content/uploads/2018/12/cropped-9836b00030f5b01c0b638441173e8a18-180x180.jpg",
    siteLabel: "ALETTA 公式サイト",
    siteUrl: "https://aletta-kurume.com/",
  },
};

module.exports = { VENUE_LOGOS };
