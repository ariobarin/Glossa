import { z } from "zod";
import {
  DEFAULT_WORKER_POLL_MS,
  MAX_WORKER_POLL_MS,
} from "@glossa/protocol";

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    GLOSSA_BIND_HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().max(65535).default(39100),
    DATABASE_URL: z.string().min(1),
    GLOSSA_DATABASE_CA_PEM: z.string().trim().min(1).optional(),
    GLOSSA_PUBLIC_ORIGIN: z.string().url(),
    GLOSSA_AUTH0_ISSUER: z.string().url(),
    GLOSSA_AUTH0_AUDIENCE: z.string().url(),
    GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX: z
      .string()
      .trim()
      .min(2)
      .refine((value) => value.endsWith("|"), {
        message: "Auth0 subject prefix must end with |.",
      })
      .default("google-oauth2|"),
    GLOSSA_MCP_REQUIRED_SCOPE: z.string().default("glossa:access"),
    GLOSSA_DEVICE_ENROLL_SCOPE: z.string().default("glossa:device"),
    GLOSSA_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    GLOSSA_ENROLL_RATE_LIMIT: z.coerce.number().int().positive().default(10),
    GLOSSA_DEVICE_AUTH_RATE_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(120),
    GLOSSA_WORKER_POLL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_WORKER_POLL_MS)
      .default(DEFAULT_WORKER_POLL_MS),
    GLOSSA_RELAY_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(19_000)
      .default(18_000),
    GLOSSA_TIMING_LOGS: z
      .enum(["0", "1"])
      .default("0")
      .transform((value) => value === "1"),
  })
  .superRefine((environment, context) => {
    if (
      environment.NODE_ENV === "production" &&
      new URL(environment.GLOSSA_PUBLIC_ORIGIN).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        path: ["GLOSSA_PUBLIC_ORIGIN"],
        message: "Production public origin must use HTTPS.",
      });
    }
  });

export type RelayConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RelayConfig {
  return environmentSchema.parse(environment);
}
