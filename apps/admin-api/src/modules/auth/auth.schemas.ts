import { z } from "zod";

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
  // 6-digit authenticator code. Optional at the schema level so the API can answer a missing code
  // with a specific "TotpRequired" (after a correct password) instead of a generic 400.
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Authentication code must be 6 digits")
    .optional(),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
