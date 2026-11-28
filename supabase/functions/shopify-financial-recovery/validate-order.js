const STATUSES = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"];
const WORKSHOP_TITLE = "Taller de velas y jabones";
const money = (field) => field?.shopMoney;
const validAmount = (value) => value?.currencyCode === "EUR" && typeof value.amount === "string" &&
  /^\d+(\.\d{1,2})?$/.test(value.amount) && Number.isSafeInteger(Math.round(Number(value.amount) * 100));

// Returns null when the order is safe to import, otherwise a short reason for review.
export function reviewReason(order, candidate) {
  if (!order) return "order_not_found";
  if (order.id !== candidate.gid) return "order_id_mismatch";
  if (!Number.isFinite(Date.parse(order.createdAt))) return "invalid_created_at";
  if (!STATUSES.includes(order.displayFinancialStatus)) return "financial_status_" + String(order.displayFinancialStatus).toLowerCase();

  const lines = order.lineItems;
  if (lines?.pageInfo?.hasNextPage !== false || lines.nodes?.length !== 1) return "not_single_line";
  const [line] = lines.nodes;
  if (!line || line.isGiftCard !== false) return "gift_card";
  if (line.title !== WORKSHOP_TITLE) return "not_workshop_line";
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) return "invalid_quantity";
  if (line.quantity !== candidate.expected_seats) return "seats_mismatch";

  const amounts = [order.totalPriceSet, order.totalReceivedSet, order.totalRefundedSet].map(money);
  if (!amounts.every(validAmount)) return "currency_or_amount_invalid";
  if (Number(amounts[2].amount) > Number(amounts[1].amount)) return "refund_exceeds_received";
  return null;
}

export function validateOrder(order, candidate) {
  return reviewReason(order, candidate) === null;
}

// Payload row for public.os_import_shopify_financials_api(jsonb). Amounts are the real
// received and refunded totals, so 100 % discounts import as 0 received.
export function toImportRow(order) {
  return {
    gid: order.id,
    name: order.name,
    created_at: order.createdAt,
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    quantity: order.lineItems.nodes[0].quantity,
    gross: money(order.totalPriceSet).amount,
    received: money(order.totalReceivedSet).amount,
    refunded: money(order.totalRefundedSet).amount,
    currency: "EUR",
    single_workshop_line: true,
  };
}
