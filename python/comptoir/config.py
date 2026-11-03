"""The Comptoir's settings, read from the environment when they exist.

The API key never appears here: the SDK reads it itself from
the ANTHROPIC_API_KEY environment variable.
"""

import os

# The model is a setting, not a constant buried in the code:
# the day it is retired, you change it here, after evaluation (chapter 21).
MODEL = os.environ.get("COMPTOIR_MODEL", "claude-sonnet-5-5")

# The effort level chosen in chapter 3, by measurement. Empty = the model's default.
EFFORT = os.environ.get("COMPTOIR_EFFORT") or None

# Chapter 12: one model and one effort per step, chosen by measurement.
# The router and the questions: Claude Haiku 5.5, thinking disabled (90 out of 90 for the classification;
# 20 out of 20 on the questions of chapter 11, without citations).
ROUTER_MODEL = os.environ.get("COMPTOIR_ROUTER_MODEL", "claude-haiku-5-5")
DOCUMENTS_MODEL = os.environ.get("COMPTOIR_DOCUMENTS_MODEL", "claude-haiku-5-5")
# Complaints: extraction and evaluation by this model, drafting by MODEL.
AUXILIARY_MODEL = os.environ.get("COMPTOIR_AUXILIARY_MODEL", "claude-haiku-5-5")
# Chapter 17: the routed Comptoir (orders and other requests), chosen by the evaluation:
# Claude Haiku 5.5 does at least as well as Sonnet 5.5 on the 60 cases, for six times less
# (decisions/model.md). Complaint drafting stays on MODEL.
COMPTOIR_MODEL = os.environ.get("COMPTOIR_COMPTOIR_MODEL", "claude-haiku-5-5")
# Three sentences do not need thinking. Measured on 12 complaints: at the default effort,
# up to 339 thinking tokens and 425 output tokens, $0.00313 and 6.2 s per complaint; at low,
# no thinking, 136 tokens at most, $0.00252 and 5.5 s; 12 compliant at the first attempt in both
# cases. Empty = the model's default.
DRAFTING_EFFORT = os.environ.get("COMPTOIR_DRAFTING_EFFORT", "low") or None

# Maximum duration of a call, in seconds (chapter 6). The SDK's default, 600 s, is made
# for long generations, not for a chat on a phone.
TIMEOUT_S = float(os.environ.get("COMPTOIR_TIMEOUT_S", "60"))

# A conversation with no message for this number of hours is closed; the next one starts from zero.
EXPIRY_H = float(os.environ.get("COMPTOIR_EXPIRY_H", "24"))

# A conversation whose context goes beyond this number of tokens is closed too.
# The book's choice for a customer service, very far from the one-million-token window.
MAX_CONTEXT = int(os.environ.get("COMPTOIR_MAX_CONTEXT", "40000"))

# Conversations are customer data: they live outside the repository, and are
# deleted after this number of days (chapter 18 for the legal framework).
CONVERSATIONS = os.environ.get("COMPTOIR_CONVERSATIONS", "customer_data/conversations.sqlite3")
RETENTION_DAYS = int(os.environ.get("COMPTOIR_RETENTION_DAYS", "30"))

# Chapter 18: the shop keeps customer data too. Periods chosen by Awa, to be reviewed against
# the legal framework of her country: a passed-on request is erased after 90 days; the customer name
# on an order is reduced to the first name and initial after 90 days, the rest (products, total,
# neighborhood) stays for the accounts and the sales. A summary never confirmed goes after 2 days.
SHOP = os.environ.get("COMPTOIR_SHOP", "customer_data/shop.sqlite3")
REQUEST_RETENTION_DAYS = int(os.environ.get("COMPTOIR_REQUEST_RETENTION_DAYS", "90"))
NAME_RETENTION_DAYS = int(os.environ.get("COMPTOIR_NAME_RETENTION_DAYS", "90"))
SUMMARY_RETENTION_DAYS = int(os.environ.get("COMPTOIR_SUMMARY_RETENTION_DAYS", "2"))

# Chapter 18: the limits per network address, in front of the budget. An address can be shared by
# many subscribers of a mobile operator: these limits are generous, made to stop a script,
# not a family. The quota per address, in dollars, always leaves a share of the day to the others.
MESSAGES_PER_MINUTE_LIMIT = int(os.environ.get("COMPTOIR_MESSAGES_PER_MINUTE_LIMIT", "20"))
CONVERSATIONS_PER_HOUR_LIMIT = int(os.environ.get("COMPTOIR_CONVERSATIONS_PER_HOUR_LIMIT", "10"))
NETWORK_DAILY_QUOTA = float(os.environ.get("COMPTOIR_NETWORK_DAILY_QUOTA", "0.40"))
MAX_REQUEST_SIZE = int(os.environ.get("COMPTOIR_MAX_REQUEST_SIZE", "16384"))  # bytes
# The proxies whose X-Forwarded-For header is believed (Caddy, on the same machine); empty: none.
TRUSTED_PROXIES = [p for p in os.environ.get("COMPTOIR_TRUSTED_PROXIES", "").split(",") if p]

# The SDK's automatic retries (chapter 8). The SDK's default is 2; a chat has no
# interest in making the customer wait much longer.
RETRIES = int(os.environ.get("COMPTOIR_RETRIES", "2"))

# The API budget, set by Awa (requirement I7 of chapter 1): 15,000 FCFA a month,
# about $26. The daily ceiling is 1.5 times an average day, for festive
# days; the monthly ceiling, for its part, is never exceeded. The book's choice: set them.
MONTHLY_BUDGET = float(os.environ.get("COMPTOIR_MONTHLY_BUDGET", "26"))
DAILY_BUDGET = float(os.environ.get("COMPTOIR_DAILY_BUDGET", "1.30"))
CUSTOMER_DAILY_QUOTA = float(os.environ.get("COMPTOIR_CUSTOMER_DAILY_QUOTA", "0.15"))
ALERT_THRESHOLD = float(os.environ.get("COMPTOIR_ALERT_THRESHOLD", "0.8"))  # alert at 80%
BUDGET_DB = os.environ.get("COMPTOIR_BUDGET_DB", "customer_data/budget.sqlite3")

# Where the Comptoir records each call (ID, tokens, cost; never the key).
LOG = os.environ.get("COMPTOIR_LOG", "log/calls.jsonl")

# Chapter 19: the effort of the routed Comptoir (Claude Haiku 5.5). Empty: the model's default (medium).
# A value is changed only after the evaluation of chapter 17: it changes the answers. Measured: low
# costs 8% less per conversation, but the judge goes from 97% to 93%, with answers that skip
# a step; set aside (decisions/optimization.md).
COMPTOIR_EFFORT = os.environ.get("COMPTOIR_COMPTOIR_EFFORT") or None

# Chapter 19: WhatsApp (Meta's Cloud API). Nothing is written here: everything comes from the server's
# environment. The app secret checks the signature of the webhooks; the system user token
# sends the answers; the verify token is a string chosen by Yao, also entered at Meta.
WHATSAPP_APP_SECRET = os.environ.get("COMPTOIR_WHATSAPP_APP_SECRET", "")
WHATSAPP_TOKEN = os.environ.get("COMPTOIR_WHATSAPP_TOKEN", "")
WHATSAPP_VERIFY_TOKEN = os.environ.get("COMPTOIR_WHATSAPP_VERIFY_TOKEN", "")
WHATSAPP_API_VERSION = os.environ.get("COMPTOIR_WHATSAPP_API_VERSION", "v26.0")
# Meta sends notifications of up to 3 MB (webhooks documentation): the chat's limit does not apply here.
MAX_WEBHOOK_SIZE = int(os.environ.get("COMPTOIR_MAX_WEBHOOK_SIZE", str(4 * 1024 * 1024)))
# A customer's number goes neither into the log nor into the budget: a fingerprint is written there,
# calculated with this secret salt. Changing the salt makes the old fingerprints impossible to link.
PSEUDONYM_SALT = os.environ.get("COMPTOIR_PSEUDONYM_SALT", "")

# Chapter 19: the online dashboard, reserved for Awa and Yao (token in the Authorization header).
DASHBOARD_TOKEN = os.environ.get("COMPTOIR_DASHBOARD_TOKEN", "")
# The filter of chapter 18, as monitoring: run alongside the answer, it does not delay it and blocks
# nothing; it records suspicious messages. 1 to turn it on (about $0.00005 per message).
MONITORING_FILTER = os.environ.get("COMPTOIR_MONITORING_FILTER", "0") == "1"
