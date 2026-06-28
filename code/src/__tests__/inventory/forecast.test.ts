import { describe, expect, it } from "vitest";
import { calculateStockoutForecast } from "@/lib/inventory/forecast";

describe("calculateStockoutForecast", () => {
  it("marks zero on-hand inventory as critical when there is demand", () => {
    const result = calculateStockoutForecast({
      onHand: 0,
      reorderPoint: 5,
      last30: { days: 30, unitsSold: 30 },
      last90: { days: 90, unitsSold: 90 },
      last365: { days: 365, unitsSold: 365 },
    });

    expect(result.risk).toBe("critical");
    expect(result.daysUntilStockout).toBe(0);
    expect(result.predictedDailyDemand).toBeCloseTo(1, 5);
    expect(result.suggestedReorderQty).toBe(28);
  });

  it("marks inventory as critical when stockout is within 7 days", () => {
    const result = calculateStockoutForecast({
      onHand: 6,
      reorderPoint: 10,
      last30: { days: 30, unitsSold: 30 },
      last90: { days: 90, unitsSold: 90 },
      last365: { days: 365, unitsSold: 365 },
    });

    expect(result.risk).toBe("critical");
    expect(result.daysUntilStockout).toBeCloseTo(6, 5);
  });

  it("marks inventory as soon when stockout is within 21 days", () => {
    const result = calculateStockoutForecast({
      onHand: 15,
      reorderPoint: 10,
      last30: { days: 30, unitsSold: 30 },
      last90: { days: 90, unitsSold: 90 },
      last365: { days: 365, unitsSold: 365 },
    });

    expect(result.risk).toBe("soon");
    expect(result.daysUntilStockout).toBeCloseTo(15, 5);
  });

  it("marks inventory as watch when stockout is within 45 days", () => {
    const result = calculateStockoutForecast({
      onHand: 30,
      reorderPoint: 10,
      last30: { days: 30, unitsSold: 30 },
      last90: { days: 90, unitsSold: 90 },
      last365: { days: 365, unitsSold: 365 },
    });

    expect(result.risk).toBe("watch");
    expect(result.daysUntilStockout).toBeCloseTo(30, 5);
  });

  it("marks inventory as healthy when stockout is beyond 45 days", () => {
    const result = calculateStockoutForecast({
      onHand: 60,
      reorderPoint: 10,
      last30: { days: 30, unitsSold: 30 },
      last90: { days: 90, unitsSold: 90 },
      last365: { days: 365, unitsSold: 365 },
    });

    expect(result.risk).toBe("healthy");
    expect(result.daysUntilStockout).toBeCloseTo(60, 5);
  });

  it("marks inventory as unknown when there is no demand history", () => {
    const result = calculateStockoutForecast({
      onHand: 10,
      reorderPoint: 5,
      last30: { days: 30, unitsSold: 0 },
      last90: { days: 90, unitsSold: 0 },
      last365: { days: 365, unitsSold: 0 },
    });

    expect(result.risk).toBe("unknown");
    expect(result.predictedDailyDemand).toBe(0);
    expect(result.daysUntilStockout).toBeNull();
    expect(result.suggestedReorderQty).toBe(0);
    expect(result.confidence).toBe("low");
  });

  it("weights recent demand more heavily than older demand", () => {
    const result = calculateStockoutForecast({
      onHand: 20,
      reorderPoint: 5,
      last30: { days: 30, unitsSold: 60 },
      last90: { days: 90, unitsSold: 90 },
      last365: { days: 365, unitsSold: 365 },
    });

    expect(result.predictedDailyDemand).toBeCloseTo(1.5, 5);
    expect(result.daysUntilStockout).toBeCloseTo(13.33333, 5);
    expect(result.risk).toBe("soon");
  });

  it("uses lead time and safety stock to suggest reorder quantity", () => {
    const result = calculateStockoutForecast({
      onHand: 8,
      reorderPoint: 5,
      last30: { days: 30, unitsSold: 60 },
      last90: { days: 90, unitsSold: 180 },
      last365: { days: 365, unitsSold: 730 },
      leadTimeDays: 7,
      safetyStockDays: 7,
    });

    expect(result.predictedDailyDemand).toBeCloseTo(2, 5);
    expect(result.suggestedReorderQty).toBe(20);
  });

  it("never suggests a negative reorder quantity", () => {
    const result = calculateStockoutForecast({
      onHand: 100,
      reorderPoint: 5,
      last30: { days: 30, unitsSold: 30 },
      last90: { days: 90, unitsSold: 90 },
      last365: { days: 365, unitsSold: 365 },
      leadTimeDays: 7,
      safetyStockDays: 7,
    });

    expect(result.suggestedReorderQty).toBe(0);
  });

  it("assigns confidence from demand history depth", () => {
    expect(calculateStockoutForecast({
      onHand: 20,
      reorderPoint: 5,
      last30: { days: 30, unitsSold: 15 },
      last90: { days: 90, unitsSold: 30 },
      last365: { days: 365, unitsSold: 120 },
    }).confidence).toBe("high");

    expect(calculateStockoutForecast({
      onHand: 20,
      reorderPoint: 5,
      last30: { days: 15, unitsSold: 15 },
      last90: { days: 15, unitsSold: 15 },
      last365: { days: 15, unitsSold: 15 },
    }).confidence).toBe("medium");
  });
});
