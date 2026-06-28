export type StockoutRisk = "critical" | "soon" | "watch" | "healthy" | "unknown";

export interface DemandWindow {
  days: number;
  unitsSold: number;
}

export interface ForecastInput {
  onHand: number;
  reorderPoint: number;
  last30: DemandWindow;
  last90: DemandWindow;
  last365: DemandWindow;
  leadTimeDays?: number;
  safetyStockDays?: number;
}

export interface ForecastResult {
  predictedDailyDemand: number;
  daysUntilStockout: number | null;
  risk: StockoutRisk;
  suggestedReorderQty: number;
  confidence: "high" | "medium" | "low";
}

const DEFAULT_LEAD_TIME_DAYS = 14;
const DEFAULT_SAFETY_STOCK_DAYS = 14;

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function averageDailyDemand(window: DemandWindow): number {
  const days = Math.max(1, Math.floor(nonNegative(window.days)));
  return nonNegative(window.unitsSold) / days;
}

function calculateConfidence(input: ForecastInput, predictedDailyDemand: number): ForecastResult["confidence"] {
  if (predictedDailyDemand <= 0) return "low";

  const historyDays = Math.max(
    nonNegative(input.last30.days),
    nonNegative(input.last90.days),
    nonNegative(input.last365.days),
  );
  const unitsSold =
    nonNegative(input.last30.unitsSold) +
    nonNegative(input.last90.unitsSold) +
    nonNegative(input.last365.unitsSold);

  if (historyDays >= 90 && unitsSold >= 30) return "high";
  if (historyDays >= 14 && unitsSold > 0) return "medium";
  return "low";
}

function calculateRisk(onHand: number, daysUntilStockout: number | null, predictedDailyDemand: number): StockoutRisk {
  if (predictedDailyDemand <= 0 || daysUntilStockout === null) return "unknown";
  if (onHand <= 0 || daysUntilStockout <= 7) return "critical";
  if (daysUntilStockout <= 21) return "soon";
  if (daysUntilStockout <= 45) return "watch";
  return "healthy";
}

export function calculateStockoutForecast(input: ForecastInput): ForecastResult {
  const onHand = nonNegative(input.onHand);
  const avg30 = averageDailyDemand(input.last30);
  const avg90 = averageDailyDemand(input.last90);
  const avg365 = averageDailyDemand(input.last365);
  const predictedDailyDemand = (avg30 * 0.5) + (avg90 * 0.3) + (avg365 * 0.2);
  const daysUntilStockout = predictedDailyDemand > 0 ? onHand / predictedDailyDemand : null;
  const leadTimeDays = nonNegative(input.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS);
  const safetyStockDays = nonNegative(input.safetyStockDays ?? DEFAULT_SAFETY_STOCK_DAYS);
  const suggestedReorderQty = Math.ceil(Math.max(
    0,
    (predictedDailyDemand * (leadTimeDays + safetyStockDays)) - onHand,
  ));

  return {
    predictedDailyDemand,
    daysUntilStockout,
    risk: calculateRisk(onHand, daysUntilStockout, predictedDailyDemand),
    suggestedReorderQty,
    confidence: calculateConfidence(input, predictedDailyDemand),
  };
}
