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
    GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: z
      .string()
      .trim()
      .min(2)
      .max(2048)
      .optional(),
    // Backward-compatible single-prefix input for existing self-hosted deployments.
    GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX: z
      .string()
      .trim()
      .min(2)
      .max(128)
      .refine((value) => !value.includes(","), {
        message: "Use GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES for multiple providers.",
      })
      .optional(),
    // Exact identities are useful for tightly scoped reviewer or service accounts.
    GLOSSA_AUTH0_ALLOWED_SUBJECTS: z
      .string()
      .trim()
      .min(3)
      .max(8192)
      .optional(),
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
      .max(20_000)
      .default(20_000),
    GLOSSA_TIMING_LOGS: z
      .enum(["0", "1"])
      .default("0")
      .transform((value) => value === "1"),
    // Optional OpenAI plugin-domain verification token. The public route is
    // absent unless this is configured, and returns only this exact value.
    GLOSSA_OPENAI_APPS_CHALLENGE: z.string().trim().min(1).max(4096).optional(),
    // The control panel is enabled only when all three values are set.
    GLOSSA_PANEL_CLIENT_ID: z.string().trim().min(1).max(255).optional(),
    GLOSSA_PANEL_CLIENT_SECRET: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .optional(),
    GLOSSA_PANEL_SESSION_SECRET: z.string().min(32).max(1024).optional(),
  })
  .superRefine((environment, context) => {
    if (
      environment.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES &&
      environment.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX
    ) {
      context.addIssue({
        code: "custom",
        path: ["GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES"],
        message: "Configure either plural or legacy singular Auth0 subject prefixes, not both.",
      });
    }
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
    const panelValues = [
      environment.GLOSSA_PANEL_CLIENT_ID,
      environment.GLOSSA_PANEL_CLIENT_SECRET,
      environment.GLOSSA_PANEL_SESSION_SECRET,
    ];
    if (panelValues.some((value) => value !== undefined) && panelValues.some((value) => value === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["GLOSSA_PANEL_CLIENT_ID"],
        message: "The control panel requires all three GLOSSA_PANEL_* variables.",
      });
    }
  });

type ParsedEnvironment = z.infer<typeof environmentSchema>;

const auth0SubjectPrefixSchema = z
  .string()
  .trim()
  .min(2)
  .max(128)
  .refine((value) => value.endsWith("|"), {
    message: "Auth0 subject prefix must end with |.",
  });

const auth0ExactSubjectSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[^\s,|]+\|[^\s,]+$/, {
    message: "Exact Auth0 subjects must include a provider prefix and user identifier.",
  });

export interface PanelConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

export type RelayConfig = Omit<
  ParsedEnvironment,
  | "GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES"
  | "GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX"
  | "GLOSSA_AUTH0_ALLOWED_SUBJECTS"
  | "GLOSSA_PANEL_CLIENT_ID"
  | "GLOSSA_PANEL_CLIENT_SECRET"
  | "GLOSSA_PANEL_SESSION_SECRET"
> & {
  GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: readonly string[];
  GLOSSA_AUTH0_ALLOWED_SUBJECTS: readonly string[];
  GLOSSA_PANEL: PanelConfig | undefined;
};

function commaSeparatedValues(
  raw: string,
  schema: z.ZodType<string>,
  maximum: number,
  duplicateMessage: string,
): string[] {
  return z
    .array(schema)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: duplicateMessage,
    })
    .parse(raw.split(",").map((value) => value.trim()));
}

function allowedSubjectPrefixes(environment: ParsedEnvironment): string[] {
  const raw =
    environment.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES ??
    environment.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX ??
    "google-oauth2|";
  return commaSeparatedValues(
    raw,
    auth0SubjectPrefixSchema,
    8,
    "Auth0 subject prefixes must be unique.",
  );
}

function allowedExactSubjects(environment: ParsedEnvironment): string[] {
  if (!environment.GLOSSA_AUTH0_ALLOWED_SUBJECTS) return [];
  return commaSeparatedValues(
    environment.GLOSSA_AUTH0_ALLOWED_SUBJECTS,
    auth0ExactSubjectSchema,
    32,
    "Exact Auth0 subjects must be unique.",
  );
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsed = environmentSchema.parse(environment);
  const {
    GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: _pluralInput,
    GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX: _legacyInput,
    GLOSSA_AUTH0_ALLOWED_SUBJECTS: _exactInput,
    GLOSSA_PANEL_CLIENT_ID: panelClientId,
    GLOSSA_PANEL_CLIENT_SECRET: panelClientSecret,
    GLOSSA_PANEL_SESSION_SECRET: panelSessionSecret,
    ...config
  } = parsed;
  return {
    ...config,
    GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: allowedSubjectPrefixes(parsed),
    GLOSSA_AUTH0_ALLOWED_SUBJECTS: allowedExactSubjects(parsed),
    GLOSSA_PANEL:
      panelClientId && panelClientSecret && panelSessionSecret
        ? {
            clientId: panelClientId,
            clientSecret: panelClientSecret,
            sessionSecret: panelSessionSecret,
          }
        : undefined,
  };
}
