export type WorkerEnv = Env & {
	DEEPSEEK_API_KEY?: string;
	VIEWER_TOKEN?: string;
	FAILURE_WEBHOOK_URL?: string;
};
