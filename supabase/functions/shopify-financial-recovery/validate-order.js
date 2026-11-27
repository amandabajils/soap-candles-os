export function validateOrder(order, candidate) {
  if (order?.id !== candidate.gid || !Number.isFinite(Date.parse(order.createdAt))) return false;
  if (!["PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(order.displayFinancialStatus)) return false;

  const lines = order.lineItems;
  if (lines?.pageInfo?.hasNextPage !== false || lines.nodes?.length !== 1) return false;
  const [line] = lines.nodes;
  if (!line || line.title !== "Taller de velas y jabones" || line.isGiftCard !== false) return false;
  if (!Number.isInteger(line.quantity) || line.quantity <= 0 || line.quantity !== candidate.expected_seats) {
    return false;
  }

  const money = [order.totalPriceSet, order.totalReceivedSet, order.totalRefundedSet]
    .map((field) => field?.shopMoney);
  if (money.some((value) => value?.currencyCode !== "EUR" ||
    typeof value.amount !== "string" || !/^\d+(\.\d{1,2})?$/.test(value.amount) ||
    !Number.isSafeInteger(Math.round(Number(value.amount) * 100)))) return false;

  return Number(money[2].amount) <= Number(money[1].amount);
}
