import pino from "pino";
import { config } from "./config.js";

// Redact anything that could ever hold a secret, even if a future call site
// accidentally logs a whole object instead of a safe summary.
export const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.accessToken",
      "*.access_token",
      "*.refreshToken",
      "*.refresh_token",
      "*.password",
      "*.passwordHash",
      "*.password_hash",
    ],
    censor: "[redacted]",
  },
});
