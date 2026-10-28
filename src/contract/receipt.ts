import { z } from "zod";

export const ReceiptSchema = z.object({
  messageId: z.string().min(1),
  kind: z.enum(["delivered", "read"]),
  at: z.string().datetime(),
  sig: z.string().min(1),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
