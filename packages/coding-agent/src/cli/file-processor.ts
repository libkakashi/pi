/**
 * Process @file CLI arguments into text content and image attachments
 */

import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";
import { detectSupportedImageMimeType } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Execution environment for resolving and reading files. */
	executionEnv: ExecutionEnv;
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		const resolved = await options.executionEnv.absolutePath(fileArg);
		const absolutePath = resolved.ok ? resolved.value : fileArg;

		const info = await options.executionEnv.fileInfo(absolutePath);
		if (!info.ok) {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		if (info.value.size === 0) {
			// Skip empty files
			continue;
		}

		const binaryContent = await options.executionEnv.readBinaryFile(absolutePath);
		if (!binaryContent.ok) {
			console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${binaryContent.error.message}`));
			process.exit(1);
		}
		const content = Buffer.from(binaryContent.value);
		const mimeType = detectSupportedImageMimeType(content);

		if (mimeType) {
			// Handle image file
			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				const resized = await resizeImage(content, mimeType);
				if (!resized) {
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,
				};
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: content.toString("base64"),
				};
			}

			images.push(attachment);

			// Add text reference to image with optional dimension note
			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			const textContent = await options.executionEnv.readTextFile(absolutePath);
			if (!textContent.ok) {
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${textContent.error.message}`));
				process.exit(1);
			}
			text += `<file name="${absolutePath}">\n${textContent.value}\n</file>\n`;
		}
	}

	return { text, images };
}
