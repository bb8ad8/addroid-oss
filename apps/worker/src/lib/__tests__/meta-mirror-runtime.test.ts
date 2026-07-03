import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMetaCreative } from "../meta-mirror-runtime.js";

test("normalizeMetaCreative reads copy from asset_feed_spec when object_story_spec has no copy (Advantage+/dynamic)", () => {
  const spec = normalizeMetaCreative({
    creative: {
      id: "1065086112754429",
      name: "urakata｜ad｜A｜誰に届くか",
      object_story_spec: {
        page_id: "1098186850054003",
        instagram_user_id: "17841414792475688",
      },
      asset_feed_spec: {
        titles: [{ text: "社長のXを、裏方が伸ばす。" }],
        bodies: [
          { text: 'フォロワーの数よりも、"誰に届くか"が大切です。' },
          { text: "二番目の本文（使われないはず）" },
        ],
        call_to_action_types: ["LEARN_MORE"],
        link_urls: [{ website_url: "https://urakata.no-wave.jp/" }],
      },
    },
  });

  assert.ok(spec, "spec should not be null");
  assert.equal(spec?.headline, "社長のXを、裏方が伸ばす。");
  assert.equal(spec?.primaryText, 'フォロワーの数よりも、"誰に届くか"が大切です。');
  assert.equal(spec?.callToAction, "LEARN_MORE");
  assert.equal(spec?.linkUrl, "https://urakata.no-wave.jp/");
});

test("normalizeMetaCreative keeps object_story_spec priority over asset_feed_spec (no regression)", () => {
  const spec = normalizeMetaCreative({
    creative: {
      id: "c-1",
      object_story_spec: {
        link_data: {
          name: "既存ヘッドライン",
          message: "既存の本文メッセージ",
          link: "https://example.com/story",
        },
      },
      asset_feed_spec: {
        titles: [{ text: "asset_feed のタイトル" }],
        bodies: [{ text: "asset_feed の本文" }],
      },
    },
  });

  assert.equal(spec?.headline, "既存ヘッドライン");
  assert.equal(spec?.primaryText, "既存の本文メッセージ");
  assert.equal(spec?.linkUrl, "https://example.com/story");
});

test("normalizeMetaCreative falls back per field: object_story_spec keeps CTA/headline, asset_feed_spec fills the missing body", () => {
  const spec = normalizeMetaCreative({
    creative: {
      id: "c-mix",
      object_story_spec: {
        link_data: {
          name: "OSS 見出し",
          call_to_action: { type: "SIGN_UP" },
          // message は無い → primaryText は asset_feed_spec に落ちる
        },
      },
      asset_feed_spec: {
        bodies: [{ text: "asset_feed の本文" }],
        call_to_action_types: ["LEARN_MORE"],
      },
    },
  });

  assert.equal(spec?.headline, "OSS 見出し");
  assert.equal(spec?.callToAction, "SIGN_UP"); // object_story_spec 優先
  assert.equal(spec?.primaryText, "asset_feed の本文"); // 欠損フィールドのみ fallback
});
