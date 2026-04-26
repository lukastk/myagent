/**
 * Browser tool for Pi — headless browser automation via Puppeteer.
 * Transplanted from oh-my-pi's BrowserTool class into a closure-based defineTool.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readability } from "@mozilla/readability";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, StringEnum } from "@mariozechner/pi-ai";
import type { Static } from "@sinclair/typebox";
import { type HTMLElement, parseHTML } from "linkedom";
import type {
	Browser,
	CDPSession,
	ElementHandle,
	KeyInput,
	Page,
	default as PuppeteerType,
	SerializedAXNode,
	PuppeteerLifeCycleEvent,
} from "puppeteer";

import { ToolError, ToolAbortError, throwIfAborted } from "../lib/errors.js";
import { untilAborted } from "../lib/signals.js";
import { $which, sleep } from "../lib/utils.js";
import { htmlToBasicMarkdown } from "../lib/html-to-markdown.js";
import { resizeImage, formatDimensionNote } from "../lib/image-resize.js";
import { BROWSER_TOOL_DESCRIPTION } from "../prompts/browser.js";

// ---------------------------------------------------------------------------
// Stealth script loading
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadStealth(name: string): string {
	return readFileSync(join(__dirname, "stealth", name), "utf-8");
}

const stealthTamperingScript = loadStealth("00_stealth_tampering.txt");
const stealthActivityScript = loadStealth("01_stealth_activity.txt");
const stealthHairlineScript = loadStealth("02_stealth_hairline.txt");
const stealthBotdScript = loadStealth("03_stealth_botd.txt");
const stealthIframeScript = loadStealth("04_stealth_iframe.txt");
const stealthWebglScript = loadStealth("05_stealth_webgl.txt");
const stealthScreenScript = loadStealth("06_stealth_screen.txt");
const stealthFontsScript = loadStealth("07_stealth_fonts.txt");
const stealthAudioScript = loadStealth("08_stealth_audio.txt");
const stealthLocaleScript = loadStealth("09_stealth_locale.txt");
const stealthPluginsScript = loadStealth("10_stealth_plugins.txt");
const stealthHardwareScript = loadStealth("11_stealth_hardware.txt");
const stealthCodecsScript = loadStealth("12_stealth_codecs.txt");
const stealthWorkerScript = loadStealth("13_stealth_worker.txt");

// ---------------------------------------------------------------------------
// Puppeteer lazy-import (safe CWD workaround)
// ---------------------------------------------------------------------------

let puppeteerModule: typeof PuppeteerType | undefined;

async function loadPuppeteer(): Promise<typeof PuppeteerType> {
	if (puppeteerModule) return puppeteerModule;
	const prev = process.cwd();
	const safeDir = path.join(os.tmpdir(), "pi-puppeteer-safe");
	await fsp.mkdir(safeDir, { recursive: true });
	await fsp.writeFile(path.join(safeDir, "package.json"), "{}", "utf-8");
	try {
		process.chdir(safeDir);
		puppeteerModule = (await import("puppeteer")).default;
		return puppeteerModule;
	} finally {
		process.chdir(prev);
	}
}

// ---------------------------------------------------------------------------
// NixOS Chromium detection
// ---------------------------------------------------------------------------

let _resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

function resolveSystemChromium(): string | undefined {
	if (_resolvedChromium !== undefined) return _resolvedChromium ?? undefined;
	try {
		if (!fs.existsSync("/etc/NIXOS")) {
			_resolvedChromium = null;
			return undefined;
		}
	} catch {
		_resolvedChromium = null;
		return undefined;
	}
	const candidates = [
		$which("chromium"),
		$which("chromium-browser"),
		path.join(os.homedir(), ".nix-profile/bin/chromium"),
		"/run/current-system/sw/bin/chromium",
	];
	for (const candidate of candidates) {
		if (candidate) {
			try {
				if (fs.existsSync(candidate)) {
					_resolvedChromium = candidate;
					return candidate;
				}
			} catch {}
		}
	}
	_resolvedChromium = null;
	return undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };
const STEALTH_IGNORE_DEFAULT_ARGS = [
	"--disable-extensions",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
];
const STEALTH_ACCEPT_LANGUAGE = "en-US,en";
const PUPPETEER_SOURCE_URL_SUFFIX = "//# sourceURL=__puppeteer_evaluation_script__";
const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

// Browser timeout config
const BROWSER_TIMEOUT = { default: 30, min: 1, max: 120 };

function clampTimeout(rawTimeout?: number): number {
	const timeout = rawTimeout ?? BROWSER_TIMEOUT.default;
	return Math.max(BROWSER_TIMEOUT.min, Math.min(BROWSER_TIMEOUT.max, timeout));
}

// ---------------------------------------------------------------------------
// Global type declarations for in-page evaluate callbacks
// ---------------------------------------------------------------------------

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
	};
}

// ---------------------------------------------------------------------------
// Selector normalization
// ---------------------------------------------------------------------------

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

function normalizeSelector(selector: string): string {
	if (!selector) return selector;
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) {
		return `text/${selector.slice("p-text/".length)}`;
	}
	if (selector.startsWith("p-xpath/")) {
		return `xpath/${selector.slice("p-xpath/".length)}`;
	}
	if (selector.startsWith("p-pierce/")) {
		return `pierce/${selector.slice("p-pierce/".length)}`;
	}
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}

// ---------------------------------------------------------------------------
// Click resolution helpers
// ---------------------------------------------------------------------------

type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string };

async function resolveActionableQueryHandlerClickTarget(handles: ElementHandle[]): Promise<ElementHandle | null> {
	const candidates: Array<{
		handle: ElementHandle;
		rect: { x: number; y: number; w: number; h: number };
		ownedProxy?: ElementHandle;
	}> = [];

	for (const handle of handles) {
		let clickable: ElementHandle = handle;
		let clickableProxy: ElementHandle | null = null;
		try {
			const proxy = await handle.evaluateHandle(el => {
				const target =
					(el as Element).closest(
						'a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]',
					) ?? el;
				return target;
			});
			const nodeHandle = proxy.asElement();
			clickableProxy = nodeHandle ? (nodeHandle as unknown as ElementHandle) : null;
			if (clickableProxy) {
				clickable = clickableProxy;
			}
		} catch {
			// ignore
		}

		try {
			const intersecting = await clickable.isIntersectingViewport();
			if (!intersecting) continue;
			const rect = (await clickable.evaluate(el => {
				const r = (el as Element).getBoundingClientRect();
				return { x: r.left, y: r.top, w: r.width, h: r.height };
			})) as { x: number; y: number; w: number; h: number };
			if (rect.w < 1 || rect.h < 1) continue;
			candidates.push({ handle: clickable, rect, ownedProxy: clickableProxy ?? undefined });
		} catch {
			// ignore
		} finally {
			if (clickableProxy && clickableProxy !== handle && clickable !== clickableProxy) {
				try {
					await clickableProxy.dispose();
				} catch {}
			}
		}
	}

	if (!candidates.length) return null;

	// Prefer top-most visible element (nav/header usually wins), tie-break by left-most.
	candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const winner = candidates[0]?.handle ?? null;
	// Dispose owned proxies for non-winning candidates
	for (let i = 1; i < candidates.length; i++) {
		const c = candidates[i]!;
		if (c.ownedProxy) {
			try {
				await c.ownedProxy.dispose();
			} catch {}
		}
	}
	return winner;
}

async function isClickActionable(handle: ElementHandle): Promise<ActionabilityResult> {
	return (await handle.evaluate(el => {
		const element = el as HTMLElement;
		const style = globalThis.getComputedStyle(element);
		if (style.display === "none") return { ok: false as const, reason: "display:none" };
		if (style.visibility === "hidden") return { ok: false as const, reason: "visibility:hidden" };
		if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
		if (Number(style.opacity) === 0) return { ok: false as const, reason: "opacity:0" };

		const r = element.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return { ok: false as const, reason: "zero-size" };

		const vw = globalThis.innerWidth;
		const vh = globalThis.innerHeight;
		const left = Math.max(0, Math.min(vw, r.left));
		const right = Math.max(0, Math.min(vw, r.right));
		const top = Math.max(0, Math.min(vh, r.top));
		const bottom = Math.max(0, Math.min(vh, r.bottom));
		if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };

		const x = Math.floor((left + right) / 2);
		const y = Math.floor((top + bottom) / 2);
		const topEl = globalThis.document.elementFromPoint(x, y);
		if (!topEl) return { ok: false as const, reason: "elementFromPoint-null" };
		if (topEl === element || element.contains(topEl) || (topEl as Element).contains(element)) {
			return { ok: true as const, x, y };
		}
		return { ok: false as const, reason: "obscured" };
	})) as ActionabilityResult;
}

async function clickQueryHandlerText(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const clickSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const start = Date.now();
	let lastSeen = 0;
	let lastReason: string | null = null;

	while (Date.now() - start < timeoutMs) {
		throwIfAborted(clickSignal);
		const handles = (await untilAborted(clickSignal, () => page.$$(selector))) as ElementHandle[];
		try {
			lastSeen = handles.length;
			const target = await resolveActionableQueryHandlerClickTarget(handles);
			if (!target) {
				lastReason = handles.length ? "no-visible-candidate" : "no-matches";
				await sleep(100);
				continue;
			}
			const actionability = await isClickActionable(target);
			if (!actionability.ok) {
				lastReason = actionability.reason;
				await sleep(100);
				continue;
			}

			try {
				await untilAborted(clickSignal, () => target.click());
				return;
			} catch (err) {
				lastReason = err instanceof Error ? err.message : String(err);
				await sleep(100);
			}
		} finally {
			await Promise.all(
				handles.map(async h => {
					try {
						await h.dispose();
					} catch {}
				}),
			);
		}
	}

	throw new ToolError(
		`Timed out clicking ${selector} (seen ${lastSeen} matches; last reason: ${lastReason ?? "unknown"}). ` +
			"If there are multiple matching elements, use observe+click_id or a more specific selector.",
	);
}

// ---------------------------------------------------------------------------
// User-agent override types
// ---------------------------------------------------------------------------

type PuppeteerCdpClient = {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

type UserAgentOverride = {
	userAgent: string;
	platform: string;
	acceptLanguage: string;
	userAgentMetadata: {
		brands: Array<{ brand: string; version: string }>;
		fullVersion: string;
		platform: string;
		platformVersion: string;
		architecture: string;
		model: string;
		mobile: boolean;
	};
};

function resolvePageClient(page: Page): PuppeteerCdpClient | null {
	const pageWithClient = page as Page & {
		_client?: (() => PuppeteerCdpClient) | PuppeteerCdpClient;
	};
	if (!pageWithClient._client) return null;
	return typeof pageWithClient._client === "function" ? pageWithClient._client() : pageWithClient._client;
}

// ---------------------------------------------------------------------------
// Readable content extraction
// ---------------------------------------------------------------------------

type ReadableFormat = "text" | "markdown";
const NAVIGATION_WAIT_UNTIL_VALUES: PuppeteerLifeCycleEvent[] = ["load", "domcontentloaded", "networkidle0", "networkidle2"];
const READABLE_FORMAT_VALUES: ReadableFormat[] = ["text", "markdown"];

interface ReadableResult {
	url: string;
	title?: string;
	byline?: string;
	excerpt?: string;
	contentLength: number;
	text?: string;
	markdown?: string;
}

/** Trim to non-empty string or undefined. */
function normalize(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

function extractReadableFromHtml(html: string, url: string, format: ReadableFormat): ReadableResult | null {
	const { document } = parseHTML(html);

	// Primary: Readability article extraction
	const article = new Readability(document).parse();
	if (article) {
		const result = toReadableResult(url, format, article.textContent, article.content, {
			title: article.title,
			byline: article.byline,
			excerpt: article.excerpt,
			length: article.length,
		});
		if (result) return result;
	}

	// Fallback: CSS selector chain
	const candidates = [
		document.querySelector("[data-pagefind-body]"),
		document.querySelector("main article"),
		document.querySelector("article"),
		document.querySelector("main"),
		document.querySelector("[role='main']"),
		document.body,
	];
	for (const el of candidates) {
		if (!el) continue;
		const innerHTML = el.innerHTML?.trim();
		const textContent = el.textContent?.trim();
		if (!innerHTML || !textContent) continue;
		const result = toReadableResult(url, format, textContent, innerHTML, {
			title: document.title,
			excerpt: textContent.slice(0, 240),
			length: textContent.length,
		});
		if (result) return result;
	}

	return null;
}

function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
): ReadableResult | null {
	const text = normalize(textContent);
	const markdown = format === "markdown" ? (normalize(htmlToBasicMarkdown(htmlContent ?? "")) ?? text) : undefined;
	const normalizedText = format === "text" ? text : undefined;
	if (!normalizedText && !markdown) return null;
	return {
		url,
		title: normalize(meta.title),
		byline: normalize(meta.byline),
		excerpt: normalize(meta.excerpt),
		contentLength: meta.length ?? text?.length ?? markdown?.length ?? 0,
		text: normalizedText,
		markdown,
	};
}

// ---------------------------------------------------------------------------
// Observation types
// ---------------------------------------------------------------------------

interface ObservationEntry {
	id: number;
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	states: string[];
}

interface Observation {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	scroll: {
		x: number;
		y: number;
		width: number;
		height: number;
		scrollWidth: number;
		scrollHeight: number;
	};
	elements: ObservationEntry[];
}

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

function ensureParam<T>(value: T | undefined, name: string, action: string): T {
	if (value === undefined || value === null || value === "") {
		throw new ToolError(`Missing required parameter '${name}' for action '${action}'.`);
	}
	return value;
}

function formatEvaluateResult(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized ?? "undefined";
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// Screenshot formatting
// ---------------------------------------------------------------------------

function formatScreenshotLines(opts: {
	saveFullRes: boolean;
	savedMimeType: string;
	savedByteLength: number;
	dest: string;
	resized: { mimeType: string; buffer: Uint8Array; width: number; height: number; wasResized: boolean; originalWidth: number; originalHeight: number };
}): string[] {
	const lines = ["Screenshot captured"];
	if (opts.saveFullRes) {
		lines.push(
			`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`,
		);
		lines.push(
			`Model: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`,
		);
	} else {
		lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB)`);
		lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
	}
	const dimensionNote = formatDimensionNote(opts.resized);
	if (dimensionNote) {
		lines.push(dimensionNote);
	}
	return lines;
}

function shortenPath(filePath: string): string {
	const home = os.homedir();
	if (home && filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const puppeteerGetArgsSchema = Type.Array(
	Type.Object({
		selector: Type.String({
			description:
				"Selector for the target element (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
		attribute: Type.Optional(Type.String({ description: "Attribute name (get_attribute)" })),
	}),
	{ description: "Batch arguments for get_* actions", minItems: 1 },
);

const browserSchema = Type.Object({
	action: StringEnum(
		[
			"open",
			"goto",
			"observe",
			"click",
			"click_id",
			"type",
			"type_id",
			"fill",
			"fill_id",
			"press",
			"scroll",
			"drag",
			"wait_for_selector",
			"evaluate",
			"get_text",
			"get_html",
			"get_attribute",
			"extract_readable",
			"screenshot",
			"close",
		],
		{ description: "Action to perform" },
	),
	url: Type.Optional(Type.String({ description: "URL to navigate to (goto)" })),
	selector: Type.Optional(
		Type.String({
			description:
				"Selector for the target element (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
	),
	element_id: Type.Optional(Type.Number({ description: "Element ID from observe" })),
	include_all: Type.Optional(Type.Boolean({ description: "Include non-interactive nodes in observe" })),
	viewport_only: Type.Optional(Type.Boolean({ description: "Limit observe output to elements in the viewport" })),
	args: Type.Optional(puppeteerGetArgsSchema),
	script: Type.Optional(Type.String({ description: "JavaScript to evaluate (evaluate)" })),
	text: Type.Optional(Type.String({ description: "Text to type (type)" })),
	value: Type.Optional(Type.String({ description: "Value to set (fill)" })),
	attribute: Type.Optional(Type.String({ description: "Attribute name to read (get_attribute)" })),
	key: Type.Optional(Type.String({ description: "Keyboard key to press (press)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds", default: 30 })),
	wait_until: Type.Optional(
		StringEnum(NAVIGATION_WAIT_UNTIL_VALUES, {
			description: "Navigation wait condition (goto)",
		}),
	),
	full_page: Type.Optional(Type.Boolean({ description: "Capture full page screenshot (screenshot)" })),
	format: Type.Optional(
		StringEnum(READABLE_FORMAT_VALUES, {
			description: "Output format for extract_readable (text/markdown)",
		}),
	),
	path: Type.Optional(Type.String({ description: "Optional path to save screenshot (relative to cwd)" })),
	viewport: Type.Optional(
		Type.Object({
			width: Type.Number({ description: "Viewport width in pixels" }),
			height: Type.Number({ description: "Viewport height in pixels" }),
			device_scale_factor: Type.Optional(Type.Number({ description: "Device scale factor" })),
		}),
	),
	delta_x: Type.Optional(Type.Number({ description: "Scroll delta X (scroll)" })),
	delta_y: Type.Optional(Type.Number({ description: "Scroll delta Y (scroll)" })),
	from_selector: Type.Optional(
		Type.String({
			description:
				"Drag start selector (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
	),
	to_selector: Type.Optional(
		Type.String({
			description:
				"Drag end selector (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
	),
});

type BrowserParams = Static<typeof browserSchema>;

// ---------------------------------------------------------------------------
// Main export: createBrowserTool
// ---------------------------------------------------------------------------

export function createBrowserTool(_pi: ExtensionAPI) {
	// Closure state (replaces class private fields)
	let browser: Browser | null = null;
	let page: Page | null = null;
	let headless = true;
	let currentHeadless: boolean | null = null;
	let browserSession: CDPSession | null = null;
	let userAgentOverride: UserAgentOverride | null = null;
	let elementIdCounter = 0;
	const elementCache = new Map<number, ElementHandle>();
	const patchedClients = new WeakSet<object>();

	// -----------------------------------------------------------------------
	// Browser lifecycle
	// -----------------------------------------------------------------------

	async function closeBrowser(): Promise<void> {
		await clearElementCache();
		if (page && !page.isClosed()) {
			await page.close();
		}
		page = null;
		if (browser?.connected) {
			await browser.close();
		}
		browser = null;
		browserSession = null;
		userAgentOverride = null;
	}

	async function resetBrowser(params?: BrowserParams): Promise<Page> {
		await closeBrowser();
		currentHeadless = headless;
		const vp = params?.viewport;
		const initialViewport = vp
			? {
					width: vp.width,
					height: vp.height,
					deviceScaleFactor: vp.device_scale_factor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
				}
			: DEFAULT_VIEWPORT;
		const puppeteer = await loadPuppeteer();
		const launchArgs = [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-blink-features=AutomationControlled",
			`--window-size=${initialViewport.width},${initialViewport.height}`,
		];
		const proxy = process.env.PUPPETEER_PROXY;
		if (proxy) {
			launchArgs.push(`--proxy-server=${proxy}`);
			const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
			if (
				bypassLoopback === "true" ||
				bypassLoopback === "1" ||
				bypassLoopback === "yes" ||
				bypassLoopback === "on"
			) {
				launchArgs.push("--proxy-bypass-list=<-loopback>");
			}
		}
		const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
		if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
			launchArgs.push("--ignore-certificate-errors");
		}
		browser = await puppeteer.launch({
			headless: currentHeadless,
			defaultViewport: currentHeadless ? initialViewport : null,
			executablePath: resolveSystemChromium(),
			args: launchArgs,
			ignoreDefaultArgs: [...STEALTH_IGNORE_DEFAULT_ARGS],
		});
		page = await browser.newPage();
		await applyStealthPatches(page);
		if (currentHeadless || params?.viewport) {
			await applyViewport(page, params?.viewport);
		}
		return page;
	}

	async function ensurePage(params?: BrowserParams): Promise<Page> {
		const desiredHeadless = headless;
		if (currentHeadless !== null && currentHeadless !== desiredHeadless) {
			return resetBrowser(params);
		}
		if (page && !page.isClosed()) {
			return page;
		}
		if (!browser?.isConnected()) {
			return resetBrowser(params);
		}
		page = await browser.newPage();
		await applyStealthPatches(page);
		if (currentHeadless || params?.viewport) {
			await applyViewport(page, params?.viewport);
		}
		return page;
	}

	async function applyViewport(pg: Page, viewport?: BrowserParams["viewport"]): Promise<void> {
		if (!viewport) {
			await pg.setViewport(DEFAULT_VIEWPORT);
			return;
		}
		await pg.setViewport({
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: viewport.device_scale_factor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
		});
	}

	// -----------------------------------------------------------------------
	// Element cache
	// -----------------------------------------------------------------------

	async function clearElementCache(): Promise<void> {
		if (elementCache.size === 0) {
			elementIdCounter = 0;
			return;
		}
		const handles = Array.from(elementCache.values());
		elementCache.clear();
		elementIdCounter = 0;
		await Promise.all(
			handles.map(async handle => {
				try {
					await handle.dispose();
				} catch {
					return;
				}
			}),
		);
	}

	async function resolveCachedHandle(id: number): Promise<ElementHandle> {
		const handle = elementCache.get(id);
		if (!handle) {
			throw new ToolError(`Unknown element_id ${id}. Run observe to refresh the element list.`);
		}
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				await clearElementCache();
				throw new ToolError(`Element_id ${id} is stale. Run observe again.`);
			}
		} catch {
			await clearElementCache();
			throw new ToolError(`Element_id ${id} is stale. Run observe again.`);
		}
		return handle;
	}

	// -----------------------------------------------------------------------
	// Observation
	// -----------------------------------------------------------------------

	function isInteractiveNode(node: SerializedAXNode): boolean {
		if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
		return (
			node.checked !== undefined ||
			node.pressed !== undefined ||
			node.selected !== undefined ||
			node.expanded !== undefined ||
			node.focused === true
		);
	}

	async function collectObservationEntries(
		node: SerializedAXNode,
		entries: ObservationEntry[],
		options: { viewportOnly: boolean; includeAll: boolean },
	): Promise<void> {
		if (options.includeAll || isInteractiveNode(node)) {
			const handle = await node.elementHandle();
			if (handle) {
				let inViewport = true;
				if (options.viewportOnly) {
					try {
						inViewport = await handle.isIntersectingViewport();
					} catch {
						inViewport = false;
					}
				}
				if (inViewport) {
					const id = ++elementIdCounter;
					const states: string[] = [];
					if (node.disabled) states.push("disabled");
					if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
					if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
					if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
					if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
					if (node.required) states.push("required");
					if (node.readonly) states.push("readonly");
					if (node.multiselectable) states.push("multiselectable");
					if (node.multiline) states.push("multiline");
					if (node.modal) states.push("modal");
					if (node.focused) states.push("focused");
					elementCache.set(id, handle);
					entries.push({
						id,
						role: node.role,
						name: node.name,
						value: node.value,
						description: node.description,
						keyshortcuts: node.keyshortcuts,
						states,
					});
				} else {
					await handle.dispose();
				}
			}
		}
		for (const child of node.children ?? []) {
			await collectObservationEntries(child, entries, options);
		}
	}

	function formatObservation(observation: Observation): string {
		const viewport = `${observation.viewport.width}x${observation.viewport.height}`;
		const scroll = `x=${observation.scroll.x} y=${observation.scroll.y} viewport=${observation.scroll.width}x${observation.scroll.height} doc=${observation.scroll.scrollWidth}x${observation.scroll.scrollHeight}`;
		const lines = [
			`URL: ${observation.url}`,
			observation.title ? `Title: ${observation.title}` : "Title:",
			`Viewport: ${viewport}`,
			`Scroll: ${scroll}`,
			"Elements:",
		];
		for (const entry of observation.elements) {
			const name = entry.name ? ` "${entry.name}"` : "";
			const value = entry.value !== undefined ? ` value=${JSON.stringify(entry.value)}` : "";
			const description = entry.description ? ` desc=${JSON.stringify(entry.description)}` : "";
			const shortcuts = entry.keyshortcuts ? ` shortcuts=${JSON.stringify(entry.keyshortcuts)}` : "";
			const state = entry.states.length ? ` (${entry.states.join(", ")})` : "";
			lines.push(`${entry.id}. ${entry.role}${name}${value}${description}${shortcuts}${state}`);
		}
		return lines.join("\n");
	}

	// -----------------------------------------------------------------------
	// Stealth patches
	// -----------------------------------------------------------------------

	async function applyStealthPatches(pg: Page): Promise<void> {
		patchSourceUrl(pg);
		await applyUserAgentOverride(pg);
		await injectStealthScripts(pg);
	}

	async function applyUserAgentOverride(pg: Page): Promise<void> {
		const client = resolvePageClient(pg);
		if (!client) return;
		const override = await resolveUserAgentOverrideValue(pg);
		await sendUserAgentOverride(client, override);
		await configureUserAgentTargets(override);
	}

	async function resolveUserAgentOverrideValue(pg: Page): Promise<UserAgentOverride> {
		if (userAgentOverride) return userAgentOverride;
		const rawUserAgent = await pg.browser().userAgent();
		let ua = rawUserAgent.replace("HeadlessChrome/", "Chrome/");
		if (ua.includes("Linux") && !ua.includes("Android")) {
			ua = ua.replace(/\(([^)]+)\)/, "(Windows NT 10.0; Win64; x64)");
		}

		const uaVersionMatch = ua.match(/Chrome\/([\d|.]+)/);
		const fallbackVersionMatch = uaVersionMatch ?? (await pg.browser().version()).match(/\/([\d|.]+)/);
		const uaVersion = fallbackVersionMatch?.[1] ?? "0";
		const majorVersion = Number.parseInt(uaVersion.split(".")[0] ?? "0", 10) || 0;
		const isAndroid = ua.includes("Android");
		const platform = ua.includes("Mac OS X")
			? "MacIntel"
			: isAndroid
				? "Android"
				: ua.includes("Linux")
					? "Linux"
					: "Win32";
		const platformFull = ua.includes("Mac OS X")
			? "Mac OS X"
			: isAndroid
				? "Android"
				: ua.includes("Linux")
					? "Linux"
					: "Windows";
		const platformVersion = ua.includes("Mac OS X ")
			? (ua.match(/Mac OS X ([^)]+)/)?.[1] ?? "")
			: ua.includes("Android ")
				? (ua.match(/Android ([^;]+)/)?.[1] ?? "")
				: ua.includes("Windows ")
					? (ua.match(/Windows .*?([\d|.]+);?/)?.[1] ?? "")
					: "";
		const architecture = isAndroid ? "" : "x86";
		const model = isAndroid ? (ua.match(/Android.*?;\s([^)]+)/)?.[1] ?? "") : "";

		const brandOrders = [
			[0, 1, 2],
			[0, 2, 1],
			[1, 0, 2],
			[1, 2, 0],
			[2, 0, 1],
			[2, 1, 0],
		];
		const order = brandOrders[majorVersion % brandOrders.length] ?? brandOrders[0]!;
		const escapedChars = [" ", " ", ";"];
		const greaseyBrand = `${escapedChars[order[0]!]}Not${escapedChars[order[1]!]}A${escapedChars[order[2]!]}Brand`;
		const brands: { brand: string; version: string }[] = [];
		brands[order[0]!] = { brand: greaseyBrand, version: "99" };
		brands[order[1]!] = { brand: "Chromium", version: String(majorVersion) };
		brands[order[2]!] = { brand: "Google Chrome", version: String(majorVersion) };

		userAgentOverride = {
			userAgent: ua,
			platform,
			acceptLanguage: STEALTH_ACCEPT_LANGUAGE,
			userAgentMetadata: {
				brands,
				fullVersion: uaVersion,
				platform: platformFull,
				platformVersion,
				architecture,
				model,
				mobile: isAndroid,
			},
		};
		return userAgentOverride;
	}

	async function configureUserAgentTargets(override: UserAgentOverride): Promise<void> {
		if (!browser) return;
		if (!browserSession) {
			browserSession = await browser.target().createCDPSession();
			await browserSession.send("Target.setAutoAttach", {
				autoAttach: true,
				waitForDebuggerOnStart: false,
				flatten: true,
			});
			browserSession.on("Target.attachedToTarget", async (event: { sessionId: string }) => {
				const connection = browserSession?.connection();
				const session = connection?.session(event.sessionId);
				if (!session || !userAgentOverride) return;
				await sendUserAgentOverride(wrapSession(session), userAgentOverride);
			});
		}

		const targets = browser.targets();
		await Promise.all(
			targets.map(async target => {
				const session = await target.createCDPSession();
				await sendUserAgentOverride(wrapSession(session), override);
			}),
		);
	}

	function wrapSession(session: CDPSession): PuppeteerCdpClient {
		return {
			send: async (method, params) => session.send(method as never, params as never),
		};
	}

	async function sendUserAgentOverride(client: PuppeteerCdpClient, override: UserAgentOverride): Promise<void> {
		try {
			await client.send("Network.enable");
		} catch {}
		try {
			await client.send("Network.setUserAgentOverride", override);
		} catch {}
		try {
			await client.send("Emulation.setUserAgentOverride", override);
		} catch {}
	}

	function patchSourceUrl(pg: Page): void {
		const client = resolvePageClient(pg);
		if (!client) return;
		const clientKey = client as object;
		if (patchedClients.has(clientKey)) return;
		patchedClients.add(clientKey);
		const originalSend = client.send.bind(client);
		client.send = async (method: string, params?: Record<string, unknown>) => {
			const next = async (payload?: Record<string, unknown>) => {
				try {
					return await originalSend(method, payload);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.includes(
							"Protocol error (Network.getResponseBody): No resource with given identifier found",
						)
					) {
						return undefined;
					}
					throw error;
				}
			};
			if (!method || !params) {
				return next(params);
			}
			const key =
				method === "Runtime.evaluate"
					? "expression"
					: method === "Runtime.callFunctionOn"
						? "functionDeclaration"
						: null;
			if (!key) {
				return next(params);
			}
			const value = params[key];
			if (typeof value !== "string" || !value.includes(PUPPETEER_SOURCE_URL_SUFFIX)) {
				return next(params);
			}
			const patchedParams = { ...params, [key]: value.replace(PUPPETEER_SOURCE_URL_SUFFIX, "") };
			return next(patchedParams);
		};
	}

	async function injectStealthScripts(pg: Page): Promise<void> {
		const scripts = [
			stealthTamperingScript,
			stealthActivityScript,
			stealthHairlineScript,
			stealthBotdScript,
			stealthIframeScript,
			stealthWebglScript,
			stealthScreenScript,
			stealthFontsScript,
			stealthAudioScript,
			stealthLocaleScript,
			stealthPluginsScript,
			stealthHardwareScript,
			stealthCodecsScript,
			stealthWorkerScript,
		];

		const joint = scripts
			.map(
				script => `
		try {
			${script};
		} catch (e) {}
	`,
			)
			.join(";\n");

		await pg.evaluateOnNewDocument(`(() => {
				// Native function cache - captured before any tampering
				const iframe = document.createElement("iframe");
				iframe.style.display = "none";
				document.head.appendChild(iframe);
				const nativeWindow = iframe.contentWindow;
				if (!nativeWindow) return;

				// Cache pristine native functions
				const Function_toString = nativeWindow.Function.prototype.toString;
				const Object_getOwnPropertyDescriptor = nativeWindow.Object.getOwnPropertyDescriptor;
				const Object_getOwnPropertyDescriptors = nativeWindow.Object.getOwnPropertyDescriptors;
				const Object_getPrototypeOf = nativeWindow.Object.getPrototypeOf;
				const Object_defineProperty = nativeWindow.Object.defineProperty;
				const Object_getOwnPropertyDescriptorOriginal = nativeWindow.Object.getOwnPropertyDescriptor;
				const Object_create = nativeWindow.Object.create;
				const Object_keys = nativeWindow.Object.keys;
				const Object_getOwnPropertyNames = nativeWindow.Object.getOwnPropertyNames;
				const Object_entries = nativeWindow.Object.entries;
				const Object_setPrototypeOf = nativeWindow.Object.setPrototypeOf;
				const Object_assign = nativeWindow.Object.assign;
				const Window_setTimeout = nativeWindow.setTimeout;
				const Math_random = nativeWindow.Math.random;
				const Math_floor = nativeWindow.Math.floor;
				const Math_max = nativeWindow.Math.max;
				const Math_min = nativeWindow.Math.min;
				const Window_Event = nativeWindow.Event;
				const Promise_resolve = nativeWindow.Promise.resolve.bind(nativeWindow.Promise);
				const Window_Blob = nativeWindow.Blob;
				const Window_Proxy = nativeWindow.Proxy;
				const Intl_DateTimeFormat = nativeWindow.Intl.DateTimeFormat;
				const Date_constructor = nativeWindow.Date;


				${joint}

				document.head.removeChild(iframe);})();`);
	}

	// -----------------------------------------------------------------------
	// Tool definition
	// -----------------------------------------------------------------------

	const tool = defineTool({
		name: "browser",
		label: "Browser",
		description: BROWSER_TOOL_DESCRIPTION,
		parameters: browserSchema,
		async execute(toolCallId, params, signal) {
			try {
				throwIfAborted(signal);
				const timeoutSeconds = clampTimeout(params.timeout);
				const timeoutMs = timeoutSeconds * 1000;

				switch (params.action) {
					// ===== open =====
					case "open": {
						const pg = await untilAborted(signal, () => resetBrowser(params));
						const viewport = pg.viewport();
						const vp = viewport ?? DEFAULT_VIEWPORT;
						return {
							content: [{ type: "text", text: `Opened headless browser session (viewport: ${vp.width}x${vp.height})` }],
							details: {},
						};
					}

					// ===== close =====
					case "close": {
						await untilAborted(signal, () => closeBrowser());
						return {
							content: [{ type: "text", text: "Closed headless browser session" }],
							details: {},
						};
					}

					// ===== goto =====
					case "goto": {
						const url = ensureParam(params.url, "url", params.action);
						const pg = await ensurePage(params);
						const waitUntil = (params.wait_until ?? "networkidle2") as PuppeteerLifeCycleEvent;
						await clearElementCache();
						await untilAborted(signal, () => pg.goto(url, { waitUntil, timeout: timeoutMs }));
						const finalUrl = pg.url();
						const title = (await untilAborted(signal, () => pg.title())) as string;
						return {
							content: [{ type: "text", text: `Navigated to ${finalUrl}${title ? `\nTitle: ${title}` : ""}` }],
							details: {},
						};
					}

					// ===== observe =====
					case "observe": {
						const pg = await ensurePage(params);
						const timeoutSignal = AbortSignal.timeout(timeoutMs);
						const observeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
						await clearElementCache();
						const snapshot = (await untilAborted(observeSignal, () =>
							pg.accessibility.snapshot({ interestingOnly: !(params.include_all ?? false) }),
						)) as SerializedAXNode | null;
						if (!snapshot) {
							throw new ToolError("Accessibility snapshot unavailable");
						}
						const entries: ObservationEntry[] = [];
						await collectObservationEntries(snapshot, entries, {
							viewportOnly: params.viewport_only ?? false,
							includeAll: params.include_all ?? false,
						});
						const scroll = (await untilAborted(observeSignal, () =>
							pg.evaluate(() => {
								const win = globalThis as unknown as {
									scrollX: number;
									scrollY: number;
									innerWidth: number;
									innerHeight: number;
									document: { documentElement: { scrollWidth: number; scrollHeight: number } };
								};
								const doc = win.document.documentElement;
								return {
									x: win.scrollX,
									y: win.scrollY,
									width: win.innerWidth,
									height: win.innerHeight,
									scrollWidth: doc.scrollWidth,
									scrollHeight: doc.scrollHeight,
								};
							}),
						)) as Observation["scroll"];
						const url = pg.url();
						const title = (await untilAborted(observeSignal, () => pg.title())) as string;
						const viewport = pg.viewport() ?? DEFAULT_VIEWPORT;
						const observation: Observation = {
							url,
							title,
							viewport,
							scroll,
							elements: entries,
						};
						return {
							content: [{ type: "text", text: formatObservation(observation) }],
							details: {},
						};
					}

					// ===== click =====
					case "click": {
						const selector = ensureParam(params.selector, "selector", params.action);
						const pg = await ensurePage(params);
						const resolvedSelector = normalizeSelector(selector);
						if (resolvedSelector.startsWith("text/")) {
							await clickQueryHandlerText(pg, resolvedSelector, timeoutMs, signal);
						} else {
							const locator = pg.locator(resolvedSelector).setTimeout(timeoutMs);
							await untilAborted(signal, () => locator.click());
						}
						return {
							content: [{ type: "text", text: `Clicked ${selector}` }],
							details: {},
						};
					}

					// ===== click_id =====
					case "click_id": {
						const elementId = ensureParam(params.element_id, "element_id", params.action);
						const handle = await resolveCachedHandle(elementId);
						try {
							await untilAborted(signal, () => handle.click());
						} catch {
							await clearElementCache();
							throw new ToolError(`Element_id ${elementId} is stale. Run observe again.`);
						}
						return {
							content: [{ type: "text", text: `Clicked element ${elementId}` }],
							details: {},
						};
					}

					// ===== type =====
					case "type": {
						const selector = ensureParam(params.selector, "selector", params.action);
						const text = ensureParam(params.text, "text", params.action);
						const pg = await ensurePage(params);
						const resolvedSelector = normalizeSelector(selector);
						const locator = pg.locator(resolvedSelector).setTimeout(timeoutMs);
						const handle = (await untilAborted(signal, () => locator.waitHandle())) as ElementHandle;
						await untilAborted(signal, () => handle.type(text, { delay: 0 }));
						await handle.dispose();
						return {
							content: [{ type: "text", text: `Typed into ${selector}` }],
							details: {},
						};
					}

					// ===== type_id =====
					case "type_id": {
						const elementId = ensureParam(params.element_id, "element_id", params.action);
						const text = ensureParam(params.text, "text", params.action);
						const pg = await ensurePage(params);
						const handle = await resolveCachedHandle(elementId);
						try {
							await untilAborted(signal, () => handle.focus());
							await untilAborted(signal, () => pg.keyboard.type(text, { delay: 0 }));
						} catch {
							await clearElementCache();
							throw new ToolError(`Element_id ${elementId} is stale. Run observe again.`);
						}
						return {
							content: [{ type: "text", text: `Typed into element ${elementId}` }],
							details: {},
						};
					}

					// ===== fill =====
					case "fill": {
						const selector = ensureParam(params.selector, "selector", params.action);
						const value = ensureParam(params.value, "value", params.action);
						const pg = await ensurePage(params);
						const resolvedSelector = normalizeSelector(selector);
						const locator = pg.locator(resolvedSelector).setTimeout(timeoutMs);
						await untilAborted(signal, () => locator.fill(value));
						return {
							content: [{ type: "text", text: `Filled ${selector}` }],
							details: {},
						};
					}

					// ===== fill_id =====
					case "fill_id": {
						const elementId = ensureParam(params.element_id, "element_id", params.action);
						const value = ensureParam(params.value, "value", params.action);
						const handle = await resolveCachedHandle(elementId);
						try {
							await untilAborted(signal, () =>
								handle.evaluate((el, inputValue) => {
									const element = el as { value?: string; dispatchEvent: (event: Event) => boolean };
									if (!("value" in element)) {
										throw new Error("Target element is not a form input");
									}
									element.value = String(inputValue);
									element.dispatchEvent(new Event("input", { bubbles: true }));
									element.dispatchEvent(new Event("change", { bubbles: true }));
								}, value),
							);
						} catch {
							await clearElementCache();
							throw new ToolError(`Element_id ${elementId} is stale. Run observe again.`);
						}
						return {
							content: [{ type: "text", text: `Filled element ${elementId}` }],
							details: {},
						};
					}

					// ===== press =====
					case "press": {
						const key = ensureParam(params.key, "key", params.action) as KeyInput;
						const pg = await ensurePage(params);
						if (params.selector) {
							const resolvedSelector = normalizeSelector(params.selector as string);
							await untilAborted(signal, () => pg.focus(resolvedSelector));
						}
						await untilAborted(signal, () => pg.keyboard.press(key));
						return {
							content: [{ type: "text", text: `Pressed ${key}` }],
							details: {},
						};
					}

					// ===== scroll =====
					case "scroll": {
						const deltaY = ensureParam(params.delta_y, "delta_y", params.action);
						const deltaX = params.delta_x ?? 0;
						const pg = await ensurePage(params);
						await untilAborted(signal, () => pg.mouse.wheel({ deltaX, deltaY }));
						return {
							content: [{ type: "text", text: `Scrolled by ${deltaX}, ${deltaY}` }],
							details: {},
						};
					}

					// ===== drag =====
					case "drag": {
						const fromSelector = ensureParam(params.from_selector, "from_selector", params.action);
						const toSelector = ensureParam(params.to_selector, "to_selector", params.action);
						const pg = await ensurePage(params);
						const resolvedFromSelector = normalizeSelector(fromSelector);
						const resolvedToSelector = normalizeSelector(toSelector);
						const fromHandle = (await untilAborted(signal, () =>
							pg.$(resolvedFromSelector),
						)) as ElementHandle | null;
						const toHandle = (await untilAborted(signal, () =>
							pg.$(resolvedToSelector),
						)) as ElementHandle | null;
						if (!fromHandle || !toHandle) {
							throw new ToolError("Drag selectors did not resolve to elements");
						}
						const fromBox = (await untilAborted(signal, () => fromHandle.boundingBox())) as {
							x: number;
							y: number;
							width: number;
							height: number;
						} | null;
						const toBox = (await untilAborted(signal, () => toHandle.boundingBox())) as {
							x: number;
							y: number;
							width: number;
							height: number;
						} | null;
						await fromHandle.dispose();
						await toHandle.dispose();
						if (!fromBox || !toBox) {
							throw new ToolError("Drag elements are not visible");
						}
						const startX = fromBox.x + fromBox.width / 2;
						const startY = fromBox.y + fromBox.height / 2;
						const endX = toBox.x + toBox.width / 2;
						const endY = toBox.y + toBox.height / 2;
						await untilAborted(signal, () => pg.mouse.move(startX, startY));
						await untilAborted(signal, () => pg.mouse.down());
						await untilAborted(signal, () => pg.mouse.move(endX, endY, { steps: 12 }));
						await untilAborted(signal, () => pg.mouse.up());
						return {
							content: [{ type: "text", text: `Dragged from ${fromSelector} to ${toSelector}` }],
							details: {},
						};
					}

					// ===== wait_for_selector =====
					case "wait_for_selector": {
						const selector = ensureParam(params.selector, "selector", params.action);
						const pg = await ensurePage(params);
						const resolvedSelector = normalizeSelector(selector);
						const locator = pg.locator(resolvedSelector).setTimeout(timeoutMs);
						await untilAborted(signal, () => locator.wait());
						return {
							content: [{ type: "text", text: `Selector ready: ${selector}` }],
							details: {},
						};
					}

					// ===== evaluate =====
					case "evaluate": {
						const script = ensureParam(params.script, "script", params.action);
						const pg = await ensurePage(params);
						const value = (await untilAborted(signal, () =>
							pg.evaluate(async (source: string) => {
								try {
									return await new Function(`return (async () => (${source}))();`)();
								} catch {
									return await new Function(`return (async () => { ${source} })();`)();
								}
							}, script),
						)) as unknown;
						const output = formatEvaluateResult(value);
						return {
							content: [{ type: "text", text: output }],
							details: {},
						};
					}

					// ===== get_text =====
					case "get_text": {
						const pg = await ensurePage(params);
						if (params.args?.length) {
							const values = (await Promise.all(
								params.args.map((arg, index) => {
									const selector = ensureParam(arg.selector, `args[${index}].selector`, params.action);
									const resolvedSelector = normalizeSelector(selector);
									return untilAborted(signal, () =>
										pg.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerText),
									);
								}),
							)) as string[];
							return {
								content: [{ type: "text", text: JSON.stringify(values, null, 2) }],
								details: {},
							};
						}
						const selector = ensureParam(params.selector, "selector", params.action);
						const resolvedSelector = normalizeSelector(selector);
						const value = (await untilAborted(signal, () =>
							pg.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerText),
						)) as string;
						return {
							content: [{ type: "text", text: value }],
							details: {},
						};
					}

					// ===== get_html =====
					case "get_html": {
						const pg = await ensurePage(params);
						if (params.args?.length) {
							const values = (await Promise.all(
								params.args.map((arg, index) => {
									const selector = ensureParam(arg.selector, `args[${index}].selector`, params.action);
									const resolvedSelector = normalizeSelector(selector);
									return untilAborted(signal, () =>
										pg.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerHTML),
									);
								}),
							)) as string[];
							return {
								content: [{ type: "text", text: JSON.stringify(values, null, 2) }],
								details: {},
							};
						}
						const selector = ensureParam(params.selector, "selector", params.action);
						const resolvedSelector = normalizeSelector(selector);
						const value = (await untilAborted(signal, () =>
							pg.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerHTML),
						)) as string;
						return {
							content: [{ type: "text", text: value }],
							details: {},
						};
					}

					// ===== get_attribute =====
					case "get_attribute": {
						const pg = await ensurePage(params);
						if (params.args?.length) {
							const values = (await Promise.all(
								params.args.map((arg, index) => {
									const selector = ensureParam(arg.selector, `args[${index}].selector`, params.action);
									const attribute = ensureParam(arg.attribute, `args[${index}].attribute`, params.action);
									const resolvedSelector = normalizeSelector(selector);
									return untilAborted(signal, () =>
										pg.$eval(
											resolvedSelector,
											(el: Element, attr: string) => (el as HTMLElement).getAttribute(String(attr)),
											attribute,
										),
									);
								}),
							)) as string[];
							return {
								content: [{ type: "text", text: JSON.stringify(values, null, 2) }],
								details: {},
							};
						}
						const selector = ensureParam(params.selector, "selector", params.action);
						const attribute = ensureParam(params.attribute, "attribute", params.action);
						const resolvedSelector = normalizeSelector(selector);
						const value = (await untilAborted(signal, () =>
							pg.$eval(
								resolvedSelector,
								(el: { getAttribute: (name: string) => string | null }, attr: string) =>
									el.getAttribute(String(attr)),
								attribute,
							),
						)) as string | null;
						const output = value ?? "";
						return {
							content: [{ type: "text", text: output }],
							details: {},
						};
					}

					// ===== extract_readable =====
					case "extract_readable": {
						const pg = await ensurePage(params);
						const format = (params.format ?? "markdown") as ReadableFormat;
						const html = (await untilAborted(signal, () => pg.content())) as string;
						const url = pg.url();
						const readable = extractReadableFromHtml(html, url, format);
						if (!readable) {
							throw new ToolError("Readable content not found");
						}
						return {
							content: [{ type: "text", text: JSON.stringify(readable, null, 2) }],
							details: {},
						};
					}

					// ===== screenshot =====
					case "screenshot": {
						const pg = await ensurePage(params);
						const fullPage = params.selector ? false : (params.full_page ?? false);
						let buffer: Buffer;

						if (params.selector) {
							const resolvedSelector = normalizeSelector(params.selector as string);
							const handle = (await untilAborted(signal, () =>
								pg.$(resolvedSelector),
							)) as ElementHandle | null;
							if (!handle) {
								throw new ToolError("Screenshot selector did not resolve to an element");
							}
							buffer = (await untilAborted(signal, () => handle.screenshot({ type: "png" }))) as Buffer;
							await handle.dispose();
						} else {
							buffer = (await untilAborted(signal, () =>
								pg.screenshot({ type: "png", fullPage }),
							)) as Buffer;
						}

						// Compress aggressively for API content
						const resized = await resizeImage(
							{ type: "image", data: Buffer.from(buffer).toString("base64"), mimeType: "image/png" },
							{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
						);

						// Resolve destination: user-defined path > screenshotDir (env var) > temp file
						const screenshotDir = process.env.BROWSER_SCREENSHOT_DIR
							? path.resolve(process.env.BROWSER_SCREENSHOT_DIR)
							: undefined;
						const paramPath = params.path ? path.resolve(params.path as string) : undefined;
						let dest: string;
						if (paramPath) {
							dest = paramPath;
						} else if (screenshotDir) {
							const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
							dest = path.join(screenshotDir, `screenshot-${ts}.png`);
						} else {
							dest = path.join(os.tmpdir(), `pi-sshots-${Date.now()}.png`);
						}
						await fsp.mkdir(path.dirname(dest), { recursive: true });
						// Full-res buffer when saving to a user-defined location; resized (API copy) for temp-only.
						const saveFullRes = !!(paramPath || screenshotDir);
						const savedBuffer = saveFullRes ? buffer : resized.buffer;
						const savedMimeType = saveFullRes ? "image/png" : resized.mimeType;
						await fsp.writeFile(dest, savedBuffer);

						const lines = formatScreenshotLines({
							saveFullRes,
							savedMimeType,
							savedByteLength: savedBuffer.length,
							dest,
							resized,
						});
						return {
							content: [
								{ type: "text", text: lines.join("\n") },
								{ type: "image", data: resized.data, mimeType: resized.mimeType },
							],
							details: {},
						};
					}

					default:
						throw new ToolError(`Unsupported action: ${params.action}`);
				}
			} catch (error) {
				if (error instanceof ToolAbortError) throw error;
				if (error instanceof Error && error.name === "AbortError") {
					throw new ToolAbortError();
				}
				throw error;
			}
		},
	});

	return {
		tool,
		cleanup: closeBrowser,
		setHeadless: (v: boolean) => {
			headless = v;
		},
	};
}
