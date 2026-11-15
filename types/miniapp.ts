/**
 * Mini App and Admin Panel HTTP contracts (Worker-side).
 */
import type { TelegramId } from "./domain.js";

export type MiniAppUser = {
  telegram_id: TelegramId;
  username?: string | null;
  first_name?: string | null;
  language?: string | null;
  is_admin?: boolean;
  [key: string]: unknown;
};

export type MiniAppAuthContext = {
  user: MiniAppUser;
  initData?: string;
  isAdmin: boolean;
};

export type JsonResponseBody = Record<string, unknown> | unknown[] | string | null;

export type PanelSession = {
  token: string;
  created_at: number;
  expires_at: number;
};
