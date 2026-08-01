/**
 * meta-cv-event — 「どの action_type を CV として数えるか」をアカウント単位で解決する。
 *
 * 背景:
 *   Meta の insights が返す `actions` 配列は、同一のコンバージョン 1 件を複数の別名
 *   action_type で重複して返す。例えば 1 件の購入が
 *     purchase / omni_purchase / offsite_conversion.fb_pixel_purchase /
 *     onsite_web_purchase / onsite_web_app_purchase / web_in_store_purchase /
 *     web_app_in_store_purchase / offsite_purchase_add_20_s_calls
 *   の 8 通りで返る。これらを合計すると CV が 8 倍に膨れ、CPA が 1/8 に化ける。
 *
 *   さらに「何を CV とするか」はアカウントごとに違う (購入 / LINE 友だち追加 /
 *   カスタムコンバージョン ...) ため、固定の action_type リストでは表現できない。
 *
 * 方針:
 *   AdAccount.cvEvent に指定された 1 つの定義を解決し、**合計せず最初に一致した
 *   1 系統だけ**を採用する。解決順序は既存の検知 GAS
 *   (`~/ad-project/meta/detection-gas/src/Connector_Meta.js` の `extractCv_`) と
 *   同じにしてあり、同じアカウントなら両システムで同じ CV 数になる。
 */

/** insights の actions 配列 1 要素。value は文字列で返ることがある。 */
type ActionRow = { action_type?: unknown; value?: unknown };

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function actionType(action: unknown): string {
  if (!action || typeof action !== "object") return "";
  const value = (action as ActionRow).action_type;
  return typeof value === "string" ? value : "";
}

/** action_type が `type` と完全一致する行の合計。 */
function sumExact(actions: readonly unknown[], type: string): number {
  let total = 0;
  for (const action of actions) {
    if (actionType(action) !== type) continue;
    total += toNumber((action as ActionRow).value);
  }
  return total;
}

/** action_type に `substring` を含む行の合計 (カスタム CV の ID 検索用)。 */
function sumIncludes(actions: readonly unknown[], substring: string): number {
  let total = 0;
  for (const action of actions) {
    const type = actionType(action);
    if (!type || !type.includes(substring)) continue;
    total += toNumber((action as ActionRow).value);
  }
  return total;
}

/**
 * cvEvent 未設定時の既定。omni_purchase → purchase の順で最初に非 0 を採る。
 * 「両方を足さない」ことが多重計上を防ぐ肝。
 */
function defaultConversionCount(actions: readonly unknown[]): number {
  return sumExact(actions, "omni_purchase") || sumExact(actions, "purchase");
}

/**
 * actions 配列から CV 数を解決する。
 *
 * @param actions insights の `actions`。配列以外なら 0。
 * @param cvEvent AdAccount.cvEvent。null/空なら既定 (omni_purchase → purchase)。
 *   - 数字のみ            → カスタム CV の ID。`.custom.<ID>` を含む行、無ければ ID を含む行
 *   - "." を含む / "offsite" 始まり → 完全な action_type。完全一致、無ければ部分一致
 *   - それ以外            → 標準イベント名。完全一致 →
 *                           `offsite_conversion.fb_pixel_<ev>` → `omni_<ev>` → 部分一致
 */
export function resolveConversionCount(actions: unknown, cvEvent?: string | null): number {
  if (!Array.isArray(actions)) return 0;
  const ev = typeof cvEvent === "string" ? cvEvent.trim() : "";
  if (!ev) return Math.floor(defaultConversionCount(actions));

  if (/^\d+$/.test(ev)) {
    // カスタムコンバージョン ID。offsite_conversion.custom.<ID> の形で返る。
    return Math.floor(sumIncludes(actions, `.custom.${ev}`) || sumIncludes(actions, ev));
  }

  if (ev.includes(".") || ev.startsWith("offsite")) {
    // 完全修飾された action_type がそのまま指定されたケース。
    return Math.floor(sumExact(actions, ev) || sumIncludes(actions, ev));
  }

  // 標準イベント名 ("purchase" / "lead" など)。Meta 側の表記ゆれを順に試す。
  return Math.floor(
    sumExact(actions, ev) ||
      sumExact(actions, `offsite_conversion.fb_pixel_${ev}`) ||
      sumExact(actions, `omni_${ev}`) ||
      sumIncludes(actions, ev)
  );
}

/**
 * insights の 1 行から CV 数を取る。`conversions` フィールドが直接返っている場合は
 * それを優先する (従来挙動の維持)。
 */
export function resolveRowConversions(
  row: Record<string, unknown>,
  cvEvent?: string | null
): number {
  const direct = row.conversions;
  const directNumber = toNumber(direct);
  if (directNumber > 0) return Math.floor(directNumber);
  return resolveConversionCount(row.actions, cvEvent);
}

/**
 * actions 配列を action_type 別に合計して降順で返す。
 * `addroid accounts cv candidates` が「どの action_type を CV に選ぶか」を
 * 人が決めるために使う (検知 GAS の listCvTypes 相当)。
 */
export function tallyActionTypes(actions: unknown): Array<{ actionType: string; value: number }> {
  if (!Array.isArray(actions)) return [];
  const totals = new Map<string, number>();
  for (const action of actions) {
    const type = actionType(action);
    if (!type) continue;
    totals.set(type, (totals.get(type) ?? 0) + toNumber((action as ActionRow).value));
  }
  return [...totals.entries()]
    .map(([type, value]) => ({ actionType: type, value }))
    .sort((a, b) => b.value - a.value || a.actionType.localeCompare(b.actionType));
}
