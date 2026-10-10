/**
 * Portable Text <-> Markdown conversion layer.
 *
 * Three tiers of block handling:
 *   Tier 1: Standard PT blocks <-> standard Markdown (headings, paragraphs, lists, etc.)
 *   Tier 2: EmDash custom blocks <-> Markdown directives (future)
 *   Tier 3: Unknown blocks <-> opaque HTML comment fences (preserved, not editable)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal Portable Text block shape */
export interface PortableTextBlock {
	_type: string;
	_key?: string;
	style?: string;
	level?: number;
	listItem?: string;
	markDefs?: MarkDef[];
	children?: PortableTextSpan[];
	[key: string]: unknown;
}

interface PortableTextSpan {
	_type: string;
	_key?: string;
	text?: string;
	marks?: string[];
	[key: string]: unknown;
}

interface MarkDef {
	_key: string;
	_type: string;
	href?: string;
	[key: string]: unknown;
}

interface ParsedInline {
	spans: PortableTextSpan[];
	markDefs: MarkDef[];
}

// ---------------------------------------------------------------------------
// PT -> Markdown
// ---------------------------------------------------------------------------

/**
 * Convert Portable Text blocks to Markdown.
 * Unknown block types are serialized as opaque fences.
 */
export function portableTextToMarkdown(blocks: PortableTextBlock[]): string {
	const lines: string[] = [];
	let prevWasList = false;

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		if (block._type === "block") {
			const isList = !!block.listItem;

			// Blank line between non-contiguous block types
			if (i > 0 && (!isList || !prevWasList)) {
				lines.push("");
			}

			lines.push(renderStandardBlock(block, prevWasList));
			prevWasList = isList;
		} else if (block._type === "code") {
			if (i > 0) lines.push("");
			const lang = (block.language as string) || "";
			const code = (block.code as string) || "";
			lines.push("```" + lang);
			lines.push(code);
			lines.push("```");
			prevWasList = false;
		} else if (block._type === "image") {
			if (i > 0) lines.push("");
			const alt = (block.alt as string) || "";
			const url = (block.asset as { url?: string })?.url || "";
			lines.push(`![${alt}](${url})`);
			prevWasList = false;
		} else {
			// Tier 3: Unknown block -> opaque fence
			if (i > 0) lines.push("");
			lines.push(`<!--ec:block ${JSON.stringify(block)} -->`);
			prevWasList = false;
		}
	}

	return lines.join("\n") + "\n";
}

function renderStandardBlock(block: PortableTextBlock, afterListItem: boolean): string {
	const text = renderSpans(block.children ?? [], block.markDefs ?? []);

	// List items
	if (block.listItem) {
		const indent = "  ".repeat(Math.max(0, (block.level ?? 1) - 1));
		const marker = block.listItem === "number" ? "1." : "-";
		return `${indent}${marker} ${text}`;
	}

	// Headings
	if (block.style && block.style.startsWith("h")) {
		const level = parseInt(block.style.substring(1), 10);
		if (level >= 1 && level <= 6) {
			return `${"#".repeat(level)} ${text}`;
		}
	}

	// Blockquote
	if (block.style === "blockquote") {
		return `> ${text}`;
	}

	return renderParagraphLineBreaks(text, afterListItem);
}

/**
 * Writes a line break as a backslash hard break wherever markdownToPortableText
 * would otherwise join the next line with a space, so editor line breaks survive
 * a read and write back. A line that starts another block keeps a bare newline.
 */
function renderParagraphLineBreaks(text: string, afterListItem: boolean): string {
	let markdown = "";
	let inParagraph = false;
	for (const [index, line] of text.split("\n").entries()) {
		if (inParagraph && continuesParagraph(line, afterListItem)) {
			markdown += `\\\n${line}`;
			continue;
		}
		markdown += index === 0 ? line : `\n${line}`;
		inParagraph = continuesParagraph(line, true);
		if (!inParagraph && line.trim() !== "") {
			afterListItem = UNORDERED_LIST_PATTERN.test(line) || ORDERED_LIST_PATTERN.test(line);
		}
	}
	return markdown;
}

function renderSpans(spans: PortableTextSpan[], markDefs: MarkDef[]): string {
	let result = "";

	for (const span of spans) {
		if (span._type !== "span") continue;

		let text = span.text ?? "";
		const marks = span.marks ?? [];

		for (const mark of marks) {
			const def = markDefs.find((d) => d._key === mark);
			if (def) {
				if (def._type === "link") {
					text = `[${text}](${def.href ?? ""})`;
				}
			} else {
				switch (mark) {
					case "strong":
						text = `**${text}**`;
						break;
					case "em":
						text = `_${text}_`;
						break;
					case "code":
						text = `\`${text}\``;
						break;
					case "strike-through":
					case "strikethrough":
						text = `~~${text}~~`;
						break;
				}
			}
		}

		result += text;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Markdown -> PT
// ---------------------------------------------------------------------------

// Regex patterns for markdown parsing
const OPAQUE_FENCE_PATTERN = /^<!--ec:block (.+) -->$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_PATTERN = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^(\s*)\d+\.\s+(.+)$/;
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const CODE_FENCE_PATTERN = /^(```|~~~)/;
// In CommonMark only an ordered list that starts at 1 can interrupt a paragraph.
const PARAGRAPH_INTERRUPTING_ORDERED_LIST_PATTERN = /^\s*1\.\s+\S/;
// Table rows, thematic breaks and setext underlines stay one block per line.
const UNJOINABLE_LINE_PATTERN = /^\s*\||^ {0,3}(?:-+|=+|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/;
const HARD_BREAK_PATTERN = /(?: {2,}|\\)$/;
const INLINE_MARKDOWN_PATTERN =
	/(\*\*(.+?)\*\*)|(_(.+?)_)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))|(~~(.+?)~~)|(\*([^\s*](?:[^*]*?[^\s*])?)\*)/gs;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const WHITESPACE_PATTERN = /\s/;

/**
 * Convert Markdown to Portable Text blocks.
 * Opaque fences (<!--ec:block ... -->) are deserialized and spliced back in.
 */
export function markdownToPortableText(markdown: string): PortableTextBlock[] {
	const blocks: PortableTextBlock[] = [];
	const lines = markdown.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// Opaque fence
		const opaqueMatch = line.match(OPAQUE_FENCE_PATTERN);
		if (opaqueMatch) {
			try {
				blocks.push(JSON.parse(opaqueMatch[1]) as PortableTextBlock);
			} catch {
				blocks.push(makeBlock(line));
			}
			i++;
			continue;
		}

		// Code fence
		const fenceMatch = line.match(CODE_FENCE_PATTERN);
		if (fenceMatch) {
			const fence = fenceMatch[1];
			const lang = line.slice(3).trim();
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith(fence)) {
				codeLines.push(lines[i]);
				i++;
			}
			blocks.push({
				_type: "code",
				_key: generateKey(),
				language: lang || undefined,
				code: codeLines.join("\n"),
			});
			i++; // skip closing ```
			continue;
		}

		// Blank line
		if (line.trim() === "") {
			i++;
			continue;
		}

		// Heading
		const headingMatch = line.match(HEADING_PATTERN);
		if (headingMatch) {
			blocks.push(makeBlock(headingMatch[2], `h${headingMatch[1].length}`));
			i++;
			continue;
		}

		// Blockquote
		if (line.startsWith("> ")) {
			blocks.push(makeBlock(line.slice(2), "blockquote"));
			i++;
			continue;
		}

		// Unordered list
		const ulMatch = line.match(UNORDERED_LIST_PATTERN);
		if (ulMatch) {
			const level = Math.floor(ulMatch[1].length / 2) + 1;
			blocks.push(makeListBlock(ulMatch[2], "bullet", level));
			i++;
			continue;
		}

		// Ordered list
		const olMatch = line.match(ORDERED_LIST_PATTERN);
		if (olMatch) {
			const level = Math.floor(olMatch[1].length / 2) + 1;
			blocks.push(makeListBlock(olMatch[2], "number", level));
			i++;
			continue;
		}

		// Image
		const imgMatch = line.match(IMAGE_PATTERN);
		if (imgMatch) {
			blocks.push({
				_type: "image",
				_key: generateKey(),
				alt: imgMatch[1],
				asset: { url: imgMatch[2] },
			});
			i++;
			continue;
		}

		// Paragraph
		const afterListItem = blocks.at(-1)?.listItem != null;
		let text = line;
		i++;
		while (
			i < lines.length &&
			!UNJOINABLE_LINE_PATTERN.test(line) &&
			continuesParagraph(lines[i], afterListItem)
		) {
			text = joinParagraphLines(text, lines[i]);
			i++;
		}
		blocks.push(makeBlock(text));
	}

	return blocks;
}

/**
 * After a list item any number starts the next item, so a wrapped item's
 * continuation line does not swallow the items that follow it.
 */
function continuesParagraph(line: string, afterListItem: boolean): boolean {
	return (
		line.trim() !== "" &&
		!OPAQUE_FENCE_PATTERN.test(line) &&
		!CODE_FENCE_PATTERN.test(line) &&
		!HEADING_PATTERN.test(line) &&
		!line.startsWith("> ") &&
		!UNORDERED_LIST_PATTERN.test(line) &&
		!(afterListItem ? ORDERED_LIST_PATTERN : PARAGRAPH_INTERRUPTING_ORDERED_LIST_PATTERN).test(
			line,
		) &&
		!IMAGE_PATTERN.test(line) &&
		!UNJOINABLE_LINE_PATTERN.test(line)
	);
}

/**
 * In CommonMark a line ending in two spaces or a backslash is a hard break; any
 * other line break inside a paragraph is soft and reads as a space.
 */
function joinParagraphLines(text: string, next: string): string {
	const hardBreak = HARD_BREAK_PATTERN.test(text);
	const head = text.endsWith("\\") ? text.slice(0, -1) : text;
	return head.trimEnd() + (hardBreak ? "\n" : " ") + next.trimStart();
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

function makeBlock(text: string, style: string = "normal"): PortableTextBlock {
	const { spans, markDefs } = parseInline(text);
	return { _type: "block", _key: generateKey(), style, markDefs, children: spans };
}

function makeListBlock(text: string, listItem: string, level: number): PortableTextBlock {
	const { spans, markDefs } = parseInline(text);
	return {
		_type: "block",
		_key: generateKey(),
		style: "normal",
		listItem,
		level,
		markDefs,
		children: spans,
	};
}

/**
 * Parse inline markdown (bold, italic, code, links, strikethrough) into PT spans + markDefs.
 */
function parseInline(text: string): ParsedInline {
	const spans: PortableTextSpan[] = [];
	const markDefs: MarkDef[] = [];
	const regex = INLINE_MARKDOWN_PATTERN;

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(text)) !== null) {
		if (match[4] != null && joinsSnakeCaseNames(text, match.index, match[0].length)) {
			regex.lastIndex = match.index + 1;
			continue;
		}

		if (match.index > lastIndex) {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: text.slice(lastIndex, match.index),
				marks: [],
			});
		}

		if (match[2] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: match[2], marks: ["strong"] });
		} else if (match[4] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: match[4], marks: ["em"] });
		} else if (match[6] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: match[6], marks: ["code"] });
		} else if (match[8] != null && match[9] != null) {
			const key = generateKey();
			markDefs.push({ _key: key, _type: "link", href: match[9] });
			spans.push({ _type: "span", _key: generateKey(), text: match[8], marks: [key] });
		} else if (match[11] != null) {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: match[11],
				marks: ["strike-through"],
			});
		} else if (match[13] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: match[13], marks: ["em"] });
		}

		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		spans.push({ _type: "span", _key: generateKey(), text: text.slice(lastIndex), marks: [] });
	}

	if (spans.length === 0) {
		spans.push({ _type: "span", _key: generateKey(), text, marks: [] });
	}

	return { spans, markDefs };
}

/**
 * An underscore pair that sits inside a word at both ends and spans a space
 * joins two snake_case names, as in `file_name and user_id`, not an emphasis.
 */
function joinsSnakeCaseNames(text: string, index: number, length: number): boolean {
	return (
		WORD_CHARACTER_PATTERN.test(text[index - 1] ?? "") &&
		WORD_CHARACTER_PATTERN.test(text[index + length] ?? "") &&
		WHITESPACE_PATTERN.test(text.slice(index, index + length))
	);
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

let keyCounter = 0;

function generateKey(): string {
	return `k${(keyCounter++).toString(36)}`;
}

/** Reset key counter (useful for testing) */
export function resetKeyCounter(): void {
	keyCounter = 0;
}

// ---------------------------------------------------------------------------
// Schema-aware conversion helpers
// ---------------------------------------------------------------------------

export interface FieldSchema {
	slug: string;
	type: string;
	blockTypes?: Array<{
		slug: string;
		currentVersion: number;
		versions: Array<{
			version: number;
			fields: Array<{ slug: string; type: string }>;
		}>;
	}>;
}

function convertNestedBlockPortableText(
	value: unknown,
	field: FieldSchema,
	direction: "read" | "write",
): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((block) => {
		if (!block || typeof block !== "object" || Array.isArray(block)) return block;
		const record = { ...block };
		const type = typeof record._type === "string" ? record._type : undefined;
		const version = typeof record._version === "number" ? record._version : undefined;
		const blockType = field.blockTypes?.find((candidate) => candidate.slug === type);
		const definition = blockType?.versions.find(
			(candidate) => candidate.version === (version ?? blockType.currentVersion),
		);
		if (!definition) return block;
		for (const nestedField of definition.fields) {
			if (nestedField.type !== "portableText") continue;
			const nestedValue = record[nestedField.slug];
			if (direction === "read" && Array.isArray(nestedValue)) {
				record[nestedField.slug] = portableTextToMarkdown(nestedValue as PortableTextBlock[]);
			} else if (direction === "write" && typeof nestedValue === "string") {
				record[nestedField.slug] = markdownToPortableText(nestedValue);
			}
		}
		return record;
	});
}

/**
 * Convert content data for reading: PT fields -> markdown strings.
 * Only converts fields with type "portableText" that contain arrays.
 */
export function convertDataForRead(
	data: Record<string, unknown>,
	fields: FieldSchema[],
	raw: boolean = false,
): Record<string, unknown> {
	if (raw) return data;

	const result = { ...data };
	for (const field of fields) {
		if (field.type === "portableText" && Array.isArray(result[field.slug])) {
			result[field.slug] = portableTextToMarkdown(result[field.slug] as PortableTextBlock[]);
		} else if (field.type === "blocks") {
			result[field.slug] = convertNestedBlockPortableText(result[field.slug], field, "read");
		}
	}
	return result;
}

/**
 * Convert content data for writing: markdown strings -> PT arrays.
 * Only converts fields with type "portableText" that contain strings.
 */
export function convertDataForWrite(
	data: Record<string, unknown>,
	fields: FieldSchema[],
): Record<string, unknown> {
	const result = { ...data };
	for (const field of fields) {
		if (field.type === "portableText" && typeof result[field.slug] === "string") {
			result[field.slug] = markdownToPortableText(result[field.slug] as string);
		} else if (field.type === "blocks") {
			result[field.slug] = convertNestedBlockPortableText(result[field.slug], field, "write");
		}
	}
	return result;
}
