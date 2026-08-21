import { describe, it, expect } from "vitest";
import { CreateTaskSchema, UpdateTaskSchema } from "@/lib/validation";

describe("Validation Layer", () => {
  describe("CreateTaskSchema", () => {
    it("accepts valid input", () => {
      const valid = {
        title: "Test Task",
        description: "Test Description",
        status: "TODO",
        priority: "HIGH",
      };
      const result = CreateTaskSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("rejects missing title", () => {
      const invalid = { description: "No title" };
      const result = CreateTaskSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects invalid status", () => {
      const invalid = { title: "Test", status: "INVALID_STATUS" };
      const result = CreateTaskSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("UpdateTaskSchema", () => {
    it("accepts partial updates", () => {
      const validPartial = { status: "DONE" };
      const result = UpdateTaskSchema.safeParse(validPartial);
      expect(result.success).toBe(true);
    });
  });
});
