/**
 * HTML-to-Markdown conversion using Turndown with GFM support.
 * Replaces @oh-my-pi/pi-natives htmlToMarkdown.
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

type TurndownListParent = {
	nodeName: string;
	getAttribute(name: string): string | null;
	children: ArrayLike<unknown>;
};

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndown.use(gfm);
turndown.addRule("strikethrough", {
	filter: ["del", "s", "strike"] as any,
	replacement(content) {
		return `~~${content}~~`;
	},
});
turndown.addRule("heading", {
	filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
	replacement(content, node) {
		const level = Number(node.nodeName.charAt(1));
		const prefix = "#".repeat(level);
		const cleaned = content.replace(/\\([.])/g, "$1").trim();
		return `\n\n${prefix} ${cleaned}\n\n`;
	},
});
turndown.addRule("listItem", {
	filter: "li",
	replacement(content, node, options) {
		content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
		const parent = node.parentNode as unknown as TurndownListParent | null;
		let prefix = `${options.bulletListMarker} `;
		if (parent?.nodeName === "OL") {
			const start = parent.getAttribute("start");
			const index = Array.prototype.indexOf.call(parent.children, node);
			prefix = `${(start ? Number(start) : 1) + index}. `;
		}
		return prefix + content + (node.nextSibling ? "\n" : "");
	},
});

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion.
 */
export function htmlToBasicMarkdown(html: string): string {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	return turndown.turndown(cleaned).trim();
}
