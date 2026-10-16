export type WorkerEnv = Env & {
	DEEPSEEK_API_KEY?: string;
	VIEWER_TOKEN?: string;
	FAILURE_WEBHOOK_URL?: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
	PUBLIC_ORIGIN?: string;
};
