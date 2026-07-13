import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  APP_NAME: z.string().default("Vision Agent API"),
  DEBUG: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  API_PREFIX: z.string().default("/v1"),
  PORT: z.coerce.number().default(8000),
  HOST: z.string().default("0.0.0.0"),

  LLM_PROVIDER: z.string().default("deepseek"),
  DEEPSEEK_API_KEY: z.string().default(""),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com"),
  DEEPSEEK_LLM_MODEL: z.string().default("deepseek-v4-pro"),
  DEEPSEEK_ROUTER_MODEL: z.string().default("deepseek-v4-flash"),

  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_LLM_MODEL: z.string().default("gpt-4o"),
  OPENAI_ROUTER_MODEL: z.string().default("gpt-4o-mini"),

  VISION_PROVIDER: z.string().default("dashscope"),
  DASHSCOPE_API_KEY: z.string().default(""),
  DASHSCOPE_BASE_URL: z
    .string()
    .default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  DASHSCOPE_VISION_MODEL: z.string().default("qwen-vl-max"),
  OPENAI_VISION_API_KEY: z.string().default(""),
  OPENAI_VISION_MODEL: z.string().default("gpt-4o-mini"),

  DATABASE_PATH: z.string().default("./vision_agent.db"),
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_IMAGE_SIZE: z.coerce.number().default(1024),
  JWT_SECRET: z.string().default("dev-secret-change-in-production"),
  JWT_ALGORITHM: z.string().default("HS256"),
  CACHE_TTL_SECONDS: z.coerce.number().default(86400),
  DEFAULT_LOCALE: z.string().default("zh-CN"),
});

const env = envSchema.parse(process.env);

const llmProvider = env.LLM_PROVIDER.toLowerCase();
const visionProvider = env.VISION_PROVIDER.toLowerCase();

const llmApiKey =
  llmProvider === "deepseek" ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY;
const llmBaseUrl =
  llmProvider === "deepseek" ? env.DEEPSEEK_BASE_URL : env.OPENAI_BASE_URL;
const llmModel =
  llmProvider === "deepseek" ? env.DEEPSEEK_LLM_MODEL : env.OPENAI_LLM_MODEL;
const routerModel =
  llmProvider === "deepseek"
    ? env.DEEPSEEK_ROUTER_MODEL
    : env.OPENAI_ROUTER_MODEL;

const llmEnabled = Boolean(llmApiKey.trim());
const visionEnabled =
  visionProvider === "dashscope"
    ? Boolean(env.DASHSCOPE_API_KEY.trim())
    : visionProvider === "openai"
      ? Boolean(
          (env.OPENAI_VISION_API_KEY || env.OPENAI_API_KEY).trim(),
        )
      : false;

export const settings = {
  appName: env.APP_NAME,
  debug: Boolean(env.DEBUG),
  apiPrefix: env.API_PREFIX,
  port: env.PORT,
  host: env.HOST,
  llmProvider,
  deepseekApiKey: env.DEEPSEEK_API_KEY,
  deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
  deepseekLlmModel: env.DEEPSEEK_LLM_MODEL,
  deepseekRouterModel: env.DEEPSEEK_ROUTER_MODEL,
  openaiApiKey: env.OPENAI_API_KEY,
  openaiBaseUrl: env.OPENAI_BASE_URL,
  openaiLlmModel: env.OPENAI_LLM_MODEL,
  openaiRouterModel: env.OPENAI_ROUTER_MODEL,
  visionProvider,
  dashscopeApiKey: env.DASHSCOPE_API_KEY,
  dashscopeBaseUrl: env.DASHSCOPE_BASE_URL,
  dashscopeVisionModel: env.DASHSCOPE_VISION_MODEL,
  openaiVisionApiKey: env.OPENAI_VISION_API_KEY,
  openaiVisionModel: env.OPENAI_VISION_MODEL,
  databasePath: env.DATABASE_PATH,
  uploadDir: env.UPLOAD_DIR,
  maxImageSize: env.MAX_IMAGE_SIZE,
  jwtSecret: env.JWT_SECRET,
  jwtAlgorithm: env.JWT_ALGORITHM,
  cacheTtlSeconds: env.CACHE_TTL_SECONDS,
  defaultLocale: env.DEFAULT_LOCALE,
  llmApiKey,
  llmBaseUrl,
  llmModel,
  routerModel,
  llmEnabled,
  visionEnabled,
  demoMode: !llmEnabled,
} as const;
