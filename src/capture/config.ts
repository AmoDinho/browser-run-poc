export const ASSET_URLS = {
	nasdaq100: "https://www.livecharts.co.uk/MarketCharts/nasdaq100.php",
	gold: "https://www.livecharts.co.uk/MarketCharts/gold.php",
} as const;

export type Asset = keyof typeof ASSET_URLS;

export const TIMEFRAME_LABELS = {
	"30m": "30 minutes",
	"3h": "3 hours",
	"1D": "1 day",
	"1W": "1 week",
	"1M": "1 month",
	"3M": "3 months",
	"1Y": "12 months",
} as const;

export type Timeframe = keyof typeof TIMEFRAME_LABELS;

export const DAILY_TIMEFRAMES: Timeframe[] = ["1D", "30m", "3h"];

export const TIMEFRAME_FALLBACK: Partial<Record<Timeframe, Timeframe>> = {
	"3h": "30m",
};

export const INTERVAL_BUTTON_TOKENS: Record<Timeframe, readonly string[]> = {
	"30m": ["30", "30m"],
	"3h": ["3h", "180"],
	"1D": ["1D", "1d", "D"],
	"1W": ["1W", "1w", "W"],
	"1M": ["1M", "1m", "M"],
	"3M": ["3M", "3m"],
	"1Y": ["12M", "1Y", "12m"],
};

export const MIN_CHART_WIDTH = 600;
export const MIN_CHART_HEIGHT = 300;
export const CLIP_MAX_WIDTH = 1200;
export const CLIP_MAX_HEIGHT = 700;

export function isAsset(value: string): value is Asset {
	return Object.prototype.hasOwnProperty.call(ASSET_URLS, value);
}

export function isTimeframe(value: string): value is Timeframe {
	return Object.prototype.hasOwnProperty.call(TIMEFRAME_LABELS, value);
}

export function utcDate(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function isUtcDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
