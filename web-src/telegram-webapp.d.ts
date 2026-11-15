
/** Minimal Telegram WebApp typings for the Mini App shell. */
interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: TelegramWebAppUser };
  ready: () => void;
  expand: () => void;
  close: () => void;
  MainButton: { text: string; show: () => void; hide: () => void; onClick: (cb: () => void) => void };
  themeParams?: Record<string, string>;
  colorScheme?: string;
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
