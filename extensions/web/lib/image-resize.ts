/**
 * Image resize utility using sharp.
 * Replaces @oh-my-pi/pi-natives PhotonImage/SamplingFilter/ImageFormat.
 */
import sharp from "sharp";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ResizedImage {
	buffer: Uint8Array;
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: 500 * 1024,
	jpegQuality: 75,
};

async function tryEncode(
	img: sharp.Sharp,
	width: number,
	height: number,
	jpegQuality: number,
): Promise<{ buffer: Uint8Array; mimeType: string }[]> {
	const resized = img.clone().resize(width, height, { fit: "inside", withoutEnlargement: true });
	const candidates: { buffer: Uint8Array; mimeType: string }[] = [];

	try {
		const png = await resized.clone().png().toBuffer();
		candidates.push({ buffer: new Uint8Array(png), mimeType: "image/png" });
	} catch {}

	try {
		const jpeg = await resized.clone().jpeg({ quality: jpegQuality }).toBuffer();
		candidates.push({ buffer: new Uint8Array(jpeg), mimeType: "image/jpeg" });
	} catch {}

	try {
		const webp = await resized.clone().webp({ quality: jpegQuality }).toBuffer();
		candidates.push({ buffer: new Uint8Array(webp), mimeType: "image/webp" });
	} catch {}

	return candidates;
}

function pickSmallest(candidates: { buffer: Uint8Array; mimeType: string }[]): {
	buffer: Uint8Array;
	mimeType: string;
} {
	return candidates.reduce((best, c) => (c.buffer.length < best.buffer.length ? c : best));
}

export async function resizeImage(
	input: { type: "image"; data: string; mimeType: string },
	opts?: ImageResizeOptions,
): Promise<ResizedImage> {
	const options = { ...DEFAULT_OPTIONS, ...opts };
	const inputBuffer = Buffer.from(input.data, "base64");

	const img = sharp(inputBuffer);
	const metadata = await img.metadata();
	const origW = metadata.width ?? 0;
	const origH = metadata.height ?? 0;

	// Fast path: already small enough
	if (origW <= options.maxWidth && origH <= options.maxHeight && inputBuffer.length <= options.maxBytes) {
		return {
			buffer: new Uint8Array(inputBuffer),
			data: input.data,
			mimeType: input.mimeType,
			originalWidth: origW,
			originalHeight: origH,
			width: origW,
			height: origH,
			wasResized: false,
		};
	}

	// Resize to fit within max dimensions
	let targetW = Math.min(origW, options.maxWidth);
	let targetH = Math.min(origH, options.maxHeight);

	// Try with decreasing quality, then decreasing dimensions
	for (const quality of [options.jpegQuality, 60, 45, 30]) {
		const candidates = await tryEncode(img, targetW, targetH, quality);
		if (candidates.length === 0) continue;
		const best = pickSmallest(candidates);
		if (best.buffer.length <= options.maxBytes) {
			const resizedMeta = await sharp(Buffer.from(best.buffer)).metadata();
			return {
				buffer: best.buffer,
				data: Buffer.from(best.buffer).toString("base64"),
				mimeType: best.mimeType,
				originalWidth: origW,
				originalHeight: origH,
				width: resizedMeta.width ?? targetW,
				height: resizedMeta.height ?? targetH,
				wasResized: true,
			};
		}
	}

	// If still too large, reduce dimensions further
	for (let scale = 0.75; scale >= 0.25; scale -= 0.25) {
		targetW = Math.round(targetW * scale);
		targetH = Math.round(targetH * scale);
		const candidates = await tryEncode(img, targetW, targetH, 30);
		if (candidates.length === 0) continue;
		const best = pickSmallest(candidates);
		if (best.buffer.length <= options.maxBytes) {
			const resizedMeta = await sharp(Buffer.from(best.buffer)).metadata();
			return {
				buffer: best.buffer,
				data: Buffer.from(best.buffer).toString("base64"),
				mimeType: best.mimeType,
				originalWidth: origW,
				originalHeight: origH,
				width: resizedMeta.width ?? targetW,
				height: resizedMeta.height ?? targetH,
				wasResized: true,
			};
		}
	}

	// Last resort: smallest encoding at smallest size
	const lastResort = await tryEncode(img, Math.min(targetW, 256), Math.min(targetH, 256), 20);
	const best = lastResort.length > 0 ? pickSmallest(lastResort) : { buffer: new Uint8Array(inputBuffer), mimeType: input.mimeType };
	return {
		buffer: best.buffer,
		data: Buffer.from(best.buffer).toString("base64"),
		mimeType: best.mimeType,
		originalWidth: origW,
		originalHeight: origH,
		width: 0,
		height: 0,
		wasResized: true,
	};
}

export function formatDimensionNote(resized: ResizedImage): string {
	if (!resized.wasResized) return "";
	return `Original: ${resized.originalWidth}x${resized.originalHeight}, Resized: ${resized.width}x${resized.height}`;
}
