const CHART_HOSTS = ["livecharts.co.uk", "tradingview.com", "tradingview-widget.com"];

const BLOCKED_HOSTS = [
	"doubleclick.net",
	"googlesyndication.com",
	"googleadservices.com",
	"google-analytics.com",
	"googletagmanager.com",
	"fundingchoicesmessages.google.com",
	"facebook.net",
	"facebook.com",
	"hotjar.com",
	"hotjar.io",
	"scorecardresearch.com",
	"quantserve.com",
	"quantcast.com",
	"adnxs.com",
	"ads.yahoo.com",
	"taboola.com",
	"outbrain.com",
	"criteo.com",
	"criteo.net",
	"moatads.com",
	"amazon-adsystem.com",
	"cookiebot.com",
	"onetrust.com",
	"cookielaw.org",
	"pubmatic.com",
	"rubiconproject.com",
	"openx.net",
	"casalemedia.com",
	"3lift.com",
	"sharethrough.com",
	"media.net",
	"chartbeat.com",
	"newrelic.com",
	"nr-data.net",
	"fonts.googleapis.com",
	"fonts.gstatic.com",
	"use.typekit.net",
	"ads-twitter.com",
	"ads.linkedin.com",
	"licdn.com",
	"bat.bing.com",
	"clarity.ms",
	"demdex.net",
	"omtrdc.net",
	"2mdn.net",
	"adsafeprotected.com",
	"serving-sys.com",
	"adsrvr.org",
	"smartadserver.com",
	"adform.net",
	"teads.tv",
	"indexww.com",
	"bidswitch.net",
	"contextweb.com",
	"lijit.com",
	"sovrn.com",
	"imrworldwide.com",
];

export function blockedUrlPatterns(): string[] {
	return BLOCKED_HOSTS.map((host) => `*${host}*`);
}

export function shouldAbortRequest(url: string, resourceType: string): boolean {
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (isChartHost(host)) return false;
	if (resourceType === "font" || resourceType === "media") return true;
	return BLOCKED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isChartHost(host: string): boolean {
	return CHART_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
