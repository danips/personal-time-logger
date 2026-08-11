import { SETTING_KEY } from "./setting-keys.js";

export const CHATGPT_ACCOUNTS_KEY = SETTING_KEY.CHATGPT_USAGE_ACCOUNTS;

/** Returns durable account records while ignoring malformed cache members. */
export function normalizeChatGptAccounts(value) {
  return Array.isArray(value)
    ? value.filter((account) => account && typeof account === "object" && !Array.isArray(account))
    : [];
}
