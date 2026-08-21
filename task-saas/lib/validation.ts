import { z } from "zod";

export const CreateTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be 200 characters or less"),
  description: z.string().max(2000, "Description must be 2000 characters or less").optional().or(z.literal("")),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  dueDate: z
    .string()
    .refine(
      (val) => !val || !isNaN(Date.parse(val)),
      { message: "Invalid date format" }
    )
    .optional()
    .or(z.literal("")),
  tags: z.array(z.string().max(50, "Tag must be 50 characters or less")).max(10, "Maximum 10 tags allowed").optional(),
});

export const UpdateTaskSchema = CreateTaskSchema.partial();
