// The Comptoir's settings, read from the environment when they exist: the same variables, and the same
// default values, as the Python version (python/comptoir/config.py).
//
// The API key never appears here: the SDK reads it itself from the ANTHROPIC_API_KEY environment
// variable.
//
// An object, not constants: the tests change a setting (the log, for example) for the time of a trial.

const text = (name: string, fallback: string): string => process.env[name] ?? fallback;
const number = (name: string, fallback: string): number => Number(text(name, fallback));
/** An empty variable means “no value”: the model's default. */
const optional = (name: string, fallback = ""): string | null => text(name, fallback) || null;

export const config = {
  // The model is a setting, not a constant buried in the code: the day it is retired, you change it
  // here, after evaluation (chapter 21).
  MODEL: text("COMPTOIR_MODEL", "claude-sonnet-5-5"),

  // The effort level chosen in chapter 3, by measurement. Empty = the model's default.
  EFFORT: optional("COMPTOIR_EFFORT"),

  // Chapter 12: one model and one effort per step, chosen by measurement. The router and the
  // questions: Claude Haiku 5.5.
  ROUTER_MODEL: text("COMPTOIR_ROUTER_MODEL", "claude-haiku-5-5"),
  DOCUMENTS_MODEL: text("COMPTOIR_DOCUMENTS_MODEL", "claude-haiku-5-5"),
  // Complaints: extraction and evaluation by this model, drafting by MODEL.
  AUXILIARY_MODEL: text("COMPTOIR_AUXILIARY_MODEL", "claude-haiku-5-5"),
  // Chapter 17: the routed Comptoir, chosen by the evaluation (python/decisions/model.md).
  COMPTOIR_MODEL: text("COMPTOIR_COMPTOIR_MODEL", "claude-haiku-5-5"),
  // Three sentences do not need thinking (chapter 12). Empty = the model's default.
  DRAFTING_EFFORT: optional("COMPTOIR_DRAFTING_EFFORT", "low"),

  // Maximum duration of a call, in seconds (chapter 6). The SDK's default, 10 minutes, is made for
  // long generations, not for a chat on a phone.
  TIMEOUT_S: number("COMPTOIR_TIMEOUT_S", "60"),

  // A conversation with no message for this number of hours is closed; the next one starts from zero.
  EXPIRY_H: number("COMPTOIR_EXPIRY_H", "24"),
  // A conversation whose context goes beyond this number of tokens is closed too.
  MAX_CONTEXT: number("COMPTOIR_MAX_CONTEXT", "40000"),

  // Conversations are customer data: they live outside the repository, and are deleted after this
  // number of days (chapter 18 for the legal framework).
  CONVERSATIONS: text("COMPTOIR_CONVERSATIONS", "customer_data/conversations.sqlite3"),
  RETENTION_DAYS: number("COMPTOIR_RETENTION_DAYS", "30"),

  // Chapter 18: the shop's customer data, and its retention periods.
  SHOP: text("COMPTOIR_SHOP", "customer_data/shop.sqlite3"),
  REQUEST_RETENTION_DAYS: number("COMPTOIR_REQUEST_RETENTION_DAYS", "90"),
  NAME_RETENTION_DAYS: number("COMPTOIR_NAME_RETENTION_DAYS", "90"),
  SUMMARY_RETENTION_DAYS: number("COMPTOIR_SUMMARY_RETENTION_DAYS", "2"),

  // Chapter 18: the limits per network address, in front of the budget.
  MESSAGES_PER_MINUTE_LIMIT: number("COMPTOIR_MESSAGES_PER_MINUTE_LIMIT", "20"),
  CONVERSATIONS_PER_HOUR_LIMIT: number("COMPTOIR_CONVERSATIONS_PER_HOUR_LIMIT", "10"),
  NETWORK_DAILY_QUOTA: number("COMPTOIR_NETWORK_DAILY_QUOTA", "0.40"),
  MAX_REQUEST_SIZE: number("COMPTOIR_MAX_REQUEST_SIZE", "16384"), // bytes
  // The proxies whose X-Forwarded-For header is believed; empty: none.
  TRUSTED_PROXIES: text("COMPTOIR_TRUSTED_PROXIES", "").split(",").filter(Boolean),

  // The SDK's automatic retries (chapter 8). The SDK's default is 2.
  RETRIES: number("COMPTOIR_RETRIES", "2"),

  // The API budget, set by Awa (requirement I7 of chapter 1): 15,000 FCFA a month, about $26. The
  // daily ceiling is 1.5 times an average day; the monthly one is never exceeded.
  MONTHLY_BUDGET: number("COMPTOIR_MONTHLY_BUDGET", "26"),
  DAILY_BUDGET: number("COMPTOIR_DAILY_BUDGET", "1.30"),
  CUSTOMER_DAILY_QUOTA: number("COMPTOIR_CUSTOMER_DAILY_QUOTA", "0.15"),
  ALERT_THRESHOLD: number("COMPTOIR_ALERT_THRESHOLD", "0.8"), // alert at 80%
  BUDGET_DB: text("COMPTOIR_BUDGET_DB", "customer_data/budget.sqlite3"),

  // Where the Comptoir records each call (ID, tokens, cost; never the key).
  LOG: text("COMPTOIR_LOG", "log/calls.jsonl"),

  // Chapter 19: the effort of the routed Comptoir. Empty: the model's default.
  COMPTOIR_EFFORT: optional("COMPTOIR_COMPTOIR_EFFORT"),

  // Chapter 19: WhatsApp (Meta's Cloud API). Everything comes from the server's environment.
  WHATSAPP_APP_SECRET: text("COMPTOIR_WHATSAPP_APP_SECRET", ""),
  WHATSAPP_TOKEN: text("COMPTOIR_WHATSAPP_TOKEN", ""),
  WHATSAPP_VERIFY_TOKEN: text("COMPTOIR_WHATSAPP_VERIFY_TOKEN", ""),
  WHATSAPP_API_VERSION: text("COMPTOIR_WHATSAPP_API_VERSION", "v26.0"),
  MAX_WEBHOOK_SIZE: number("COMPTOIR_MAX_WEBHOOK_SIZE", String(4 * 1024 * 1024)),
  // A customer's number goes neither into the log nor into the budget: a fingerprint, with this salt.
  PSEUDONYM_SALT: text("COMPTOIR_PSEUDONYM_SALT", ""),

  // Chapter 19: the online dashboard, reserved for Awa and Yao.
  DASHBOARD_TOKEN: text("COMPTOIR_DASHBOARD_TOKEN", ""),
  // The filter of chapter 18, as monitoring: 1 to turn it on.
  MONITORING_FILTER: text("COMPTOIR_MONITORING_FILTER", "0") === "1",
};
