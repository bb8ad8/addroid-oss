import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveConversionCount,
  resolveRowConversions,
  tallyActionTypes,
} from "../meta-cv-event.js";

/**
 * 実際に act_664112733414392 (まき先生) の 2026-07-31 が返した actions。
 * 購入 58 件が 8 通りの action_type で重複して返る。合計すると 464 (= 58 x 8) になり、
 * CPA が 1/8 に化ける。この配列を回帰テストの基準にする。
 */
const REAL_DUPLICATED_PURCHASE_ACTIONS = [
  { action_type: "web_in_store_purchase", value: "58" },
  { action_type: "omni_purchase", value: "58" },
  { action_type: "offsite_purchase_add_20_s_calls", value: "58" },
  { action_type: "offsite_conversion.fb_pixel_purchase", value: "58" },
  { action_type: "onsite_web_app_purchase", value: "58" },
  { action_type: "purchase", value: "58" },
  { action_type: "web_app_in_store_purchase", value: "58" },
  { action_type: "onsite_web_purchase", value: "58" },
  { action_type: "link_click", value: "132" },
  { action_type: "video_view", value: "207" },
];

test("同一CVを返す複数のaction_typeを合計せず、実数の58を返す (回帰: 464にならない)", () => {
  assert.equal(resolveConversionCount(REAL_DUPLICATED_PURCHASE_ACTIONS, null), 58);
  assert.equal(resolveConversionCount(REAL_DUPLICATED_PURCHASE_ACTIONS, "purchase"), 58);
  assert.equal(
    resolveConversionCount(REAL_DUPLICATED_PURCHASE_ACTIONS, "offsite_conversion.fb_pixel_purchase"),
    58
  );
});

test("cvEvent 未設定なら omni_purchase を優先し、無ければ purchase にフォールバックする", () => {
  assert.equal(
    resolveConversionCount(
      [
        { action_type: "omni_purchase", value: "10" },
        { action_type: "purchase", value: "9" },
      ],
      null
    ),
    10
  );
  assert.equal(resolveConversionCount([{ action_type: "purchase", value: "9" }], null), 9);
  assert.equal(resolveConversionCount([{ action_type: "link_click", value: "9" }], null), 0);
});

test("標準イベント名は 完全一致 → fb_pixel_ → omni_ の順で解決する", () => {
  // 完全一致が最優先
  assert.equal(
    resolveConversionCount(
      [
        { action_type: "lead", value: "3" },
        { action_type: "offsite_conversion.fb_pixel_lead", value: "7" },
      ],
      "lead"
    ),
    3
  );
  // 完全一致が無ければ fb_pixel_ 版
  assert.equal(
    resolveConversionCount([{ action_type: "offsite_conversion.fb_pixel_lead", value: "7" }], "lead"),
    7
  );
  // それも無ければ omni_ 版
  assert.equal(
    resolveConversionCount([{ action_type: "omni_complete_registration", value: "4" }], "complete_registration"),
    4
  );
});

test("完全修飾された action_type は完全一致で解決し、他のCVを巻き込まない", () => {
  const actions = [
    { action_type: "offsite_conversion.fb_pixel_custom", value: "137" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "20" },
  ];
  // 職人BASE の設定値。lead 側を巻き込まないこと。
  assert.equal(resolveConversionCount(actions, "offsite_conversion.fb_pixel_custom"), 137);
});

test("数字のみの cvEvent はカスタムCVのIDとして .custom.<ID> を探す", () => {
  const actions = [
    { action_type: "offsite_conversion.custom.1234567890", value: "12" },
    { action_type: "offsite_conversion.custom.9999999999", value: "5" },
  ];
  assert.equal(resolveConversionCount(actions, "1234567890"), 12);
  assert.equal(resolveConversionCount(actions, "9999999999"), 5);
});

test("同じ action_type が複数行に分かれている場合は合算する", () => {
  assert.equal(
    resolveConversionCount(
      [
        { action_type: "purchase", value: "2" },
        { action_type: "purchase", value: "3" },
      ],
      "purchase"
    ),
    5
  );
});

test("actions が配列でない・空・不正値でも 0 を返す", () => {
  assert.equal(resolveConversionCount(null, "purchase"), 0);
  assert.equal(resolveConversionCount(undefined, null), 0);
  assert.equal(resolveConversionCount([], "purchase"), 0);
  assert.equal(resolveConversionCount([{ value: "5" }, "junk", null], "purchase"), 0);
});

test("resolveRowConversions は conversions フィールドが正なら actions より優先する", () => {
  assert.equal(
    resolveRowConversions({ conversions: "42", actions: REAL_DUPLICATED_PURCHASE_ACTIONS }, null),
    42
  );
  // conversions が 0 / 未設定なら actions から解決する
  assert.equal(
    resolveRowConversions({ conversions: "0", actions: REAL_DUPLICATED_PURCHASE_ACTIONS }, "purchase"),
    58
  );
  assert.equal(resolveRowConversions({ actions: REAL_DUPLICATED_PURCHASE_ACTIONS }, "purchase"), 58);
});

test("tallyActionTypes は action_type 別に合計して降順で返す", () => {
  const tally = tallyActionTypes(REAL_DUPLICATED_PURCHASE_ACTIONS);
  assert.equal(tally[0]!.actionType, "video_view");
  assert.equal(tally[0]!.value, 207);
  assert.equal(tally[1]!.actionType, "link_click");
  assert.equal(tally[1]!.value, 132);
  // 58 が並ぶ部分は action_type の昇順で安定させる
  assert.deepEqual(
    tally.slice(2).map((t) => t.actionType),
    [
      "offsite_conversion.fb_pixel_purchase",
      "offsite_purchase_add_20_s_calls",
      "omni_purchase",
      "onsite_web_app_purchase",
      "onsite_web_purchase",
      "purchase",
      "web_app_in_store_purchase",
      "web_in_store_purchase",
    ]
  );
  assert.equal(tallyActionTypes(null).length, 0);
});
