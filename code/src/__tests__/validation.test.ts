import { describe, it, expect } from "vitest";
import { validateBody } from "@/lib/validation/schemas";
import { z } from "zod";

// Use a simple schema for testing the validator wrapper
const testSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

describe("Validation", () => {
  it("returns success for valid data", () => {
    const result = validateBody(testSchema, { name: "Test", age: 25 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Test");
      expect(result.data.age).toBe(25);
    }
  });

  it("returns error for invalid data", () => {
    const result = validateBody(testSchema, { name: "", age: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
    }
  });

  it("returns error for missing fields", () => {
    const result = validateBody(testSchema, {});
    expect(result.success).toBe(false);
  });
});
