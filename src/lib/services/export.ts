import fs from 'fs';
import path from 'path';
import { zipSync, strToU8 } from 'fflate';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { logAudit } from '$lib/server/audit';
import { getDocument, listDocuments } from './documents';
import { listCollections, queryCollection } from './collections';
import {
	projectDocument,
	renderBlockMarkdown,
	type DocumentRecordView
} from './document-projection';
import { actorForCaller, type CallerIdentity } from './permissions';
import type { CollectionMeta, PropertyDefinition, WorkspaceRecord } from '$lib/data/types';

export { renderBlockMarkdown };

export interface MirrorConfig {
	enabled: boolean;
	outputDir: string;
	syncIntervalMs: number;
}

const DEFAULT_MIRROR_CONFIG_PATH = '.data/markdown-mirror-config.json';
const DEFAULT_MIRROR_OUTPUT_DIR = '.data/markdown-mirror';
const DEFAULT_MIRROR_SYNC_INTERVAL_MS = 60000;

/** Reads current Markdown mirror configuration from env or disk. */
export function getMirrorConfig(): MirrorConfig {
	const envEnabled = process.env.MARKDOWN_MIRROR_ENABLED === 'true';
	const envDir = process.env.MARKDOWN_MIRROR_DIR;
	const envInterval = process.env.MARKDOWN_MIRROR_INTERVAL_MS
		? parseInt(process.env.MARKDOWN_MIRROR_INTERVAL_MS, 10)
		: undefined;

	let storedConfig: Partial<MirrorConfig> = {};
	try {
		if (fs.existsSync(DEFAULT_MIRROR_CONFIG_PATH)) {
			const data = fs.readFileSync(DEFAULT_MIRROR_CONFIG_PATH, 'utf-8');
			storedConfig = JSON.parse(data);
		}
	} catch {
		// Fall back to defaults on read error
	}

	return {
		enabled: storedConfig.enabled ?? envEnabled ?? false,
		outputDir: storedConfig.outputDir ?? envDir ?? DEFAULT_MIRROR_OUTPUT_DIR,
		syncIntervalMs:
			storedConfig.syncIntervalMs ??
			(envInterval && !isNaN(envInterval) ? envInterval : DEFAULT_MIRROR_SYNC_INTERVAL_MS)
	};
}

/** Updates Markdown mirror configuration and persists it to disk. */
export function updateMirrorConfig(
	caller: CallerIdentity,
	configInput: Partial<MirrorConfig>
): MirrorConfig {
	const current = getMirrorConfig();
	const trimmedDir = configInput.outputDir?.trim();
	const updated: MirrorConfig = {
		enabled: configInput.enabled ?? current.enabled,
		outputDir: trimmedDir && trimmedDir.length > 0 ? trimmedDir : current.outputDir,
		syncIntervalMs:
			configInput.syncIntervalMs && configInput.syncIntervalMs > 0
				? configInput.syncIntervalMs
				: current.syncIntervalMs
	};

	try {
		const dir = path.dirname(DEFAULT_MIRROR_CONFIG_PATH);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(DEFAULT_MIRROR_CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
	} catch (err) {
		console.error('Failed to save markdown mirror config:', err);
		throw new Error(
			`Failed to save mirror configuration: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err }
		);
	}

	const actor = actorForCaller(caller);
	logAudit({ actor, action: 'update_mirror_config', diff: updated });
	return updated;
}

/** Sanitizes document/collection titles for filesystem safety. */
export function sanitizeFilename(name: string): string {
	const sanitized = (name || 'Untitled')
		.trim()
		.replace(/[/\\?%*:|"<>]/g, '_')
		.replace(/\s+/g, ' ');
	if (!sanitized || sanitized === '.' || sanitized === '..') {
		return 'Untitled';
	}
	return sanitized;
}

/** Verifies that targetPath is contained within rootDir to prevent path traversal. */
function ensurePathInRoot(targetPath: string, rootDir: string): string {
	const resolvedTarget = path.resolve(targetPath);
	const resolvedRoot = path.resolve(rootDir);
	if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
		throw new Error(`Path traversal detected: ${targetPath} is outside ${rootDir}`);
	}
	return resolvedTarget;
}

/** Serializes a Document title and projected block views into full CommonMark/GFM markdown. */
export function renderDocumentFileMarkdown(title: string, records: DocumentRecordView[]): string {
	const lines: string[] = [`# ${title || 'Untitled'}`];
	for (const record of records) {
		const blockText = renderBlockMarkdown(record);
		if (blockText) {
			lines.push(blockText);
		}
	}
	return lines.join('\n\n') + '\n';
}

function csvEscape(val: unknown): string {
	if (val === null || val === undefined) return '';
	if (typeof val === 'object') {
		const str = JSON.stringify(val);
		return `"${str.replace(/"/g, '""')}"`;
	}
	let str = typeof val === 'string' ? val : String(val as string | number | boolean);
	// Formula injection protection: prefix values starting with =, +, -, @, \t, or \r with single quote
	if (/^[=+\-@\t\r]/.test(str)) {
		str = `'${str}`;
	}
	if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

/** Serializes Collection records to CSV format matching the Collection's schema. */
export function collectionRecordsToCsv(
	schema: PropertyDefinition[],
	records: WorkspaceRecord[]
): string {
	const headers = ['id', ...schema.map((p) => p.label || p.key)];
	const rows: string[][] = [headers];

	for (const rec of records) {
		const row: string[] = [rec.id];
		for (const propDef of schema) {
			const propVal = rec.properties?.[propDef.key];
			if (!propVal) {
				row.push('');
				continue;
			}
			switch (propVal.type) {
				case 'text':
				case 'date':
				case 'select':
					row.push(String(propVal.value));
					break;
				case 'number':
					row.push(String(propVal.value));
					break;
				case 'checkbox':
					row.push(propVal.value ? 'true' : 'false');
					break;
				case 'relation':
					row.push(propVal.value.join(', '));
					break;
				default:
					row.push('');
			}
		}
		rows.push(row);
	}

	return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

/** Serializes Collection records to a GFM Markdown table. */
export function collectionToMarkdownTable(
	title: string,
	schema: PropertyDefinition[],
	records: WorkspaceRecord[]
): string {
	const headers = ['ID', ...schema.map((p) => p.label || p.key)];
	const delimiter = headers.map(() => '---');
	const lines = [
		`# ${title || 'Untitled'}`,
		'',
		`| ${headers.join(' | ')} |`,
		`| ${delimiter.join(' | ')} |`
	];

	for (const rec of records) {
		const rowVals: string[] = [rec.id];
		for (const propDef of schema) {
			const propVal = rec.properties?.[propDef.key];
			if (!propVal) {
				rowVals.push('');
				continue;
			}
			switch (propVal.type) {
				case 'text':
				case 'date':
				case 'select':
					rowVals.push(String(propVal.value).replace(/\|/g, '\\|'));
					break;
				case 'number':
					rowVals.push(String(propVal.value));
					break;
				case 'checkbox':
					rowVals.push(propVal.value ? '✓' : '');
					break;
				case 'relation':
					rowVals.push(propVal.value.join(', '));
					break;
				default:
					rowVals.push('');
			}
		}
		lines.push(`| ${rowVals.join(' | ')} |`);
	}

	return lines.join('\n') + '\n';
}

export interface ExportFileEntry {
	path: string;
	content: string | Uint8Array;
}

export interface WorkspaceManifest {
	version: string;
	exportedAt: number;
	workspaceId: string;
	spaceId: string;
	documents: {
		id: string;
		title: string;
		parentDocumentId?: string;
		order: string;
		path: string;
	}[];
	collections: {
		id: string;
		title: string;
		schemaPath: string;
		recordsPath: string;
		csvPath: string;
	}[];
}

export interface ExportWorkspaceResult {
	manifest: WorkspaceManifest;
	files: ExportFileEntry[];
	zipBuffer: Uint8Array;
}

/** Exports a single Document (and optionally its sub-pages) as Markdown files. */
export function exportDocument(
	caller: CallerIdentity,
	documentId: string,
	includeChildren = true
): {
	documentId: string;
	title: string;
	markdown: string;
	files: ExportFileEntry[];
} {
	const rawDocData = getDocument(caller, documentId);
	if (!rawDocData) {
		throw new Error(`Document ${documentId} not found or inaccessible`);
	}
	const projected = projectDocument(documentId, rawDocData);
	const markdown = renderDocumentFileMarkdown(projected.title, projected.records);

	const files: ExportFileEntry[] = [
		{
			path: `${sanitizeFilename(projected.title)}.md`,
			content: markdown
		}
	];

	if (includeChildren) {
		const allDocs = listDocuments(caller);
		const childrenMap = new Map<string, string[]>();
		for (const docMeta of allDocs) {
			if (docMeta.parentDocumentId) {
				const list = childrenMap.get(docMeta.parentDocumentId) ?? [];
				list.push(docMeta.id);
				childrenMap.set(docMeta.parentDocumentId, list);
			}
		}

		const addDescendants = (parentId: string, currentPathPrefix: string) => {
			const childIds = childrenMap.get(parentId) ?? [];
			for (const childId of childIds) {
				const childRaw = getDocument(caller, childId);
				if (!childRaw) continue;
				const childProj = projectDocument(childId, childRaw);
				const childMd = renderDocumentFileMarkdown(childProj.title, childProj.records);
				const childPath = `${currentPathPrefix}/${sanitizeFilename(childProj.title)}.md`;
				files.push({ path: childPath, content: childMd });
				addDescendants(childId, `${currentPathPrefix}/${sanitizeFilename(childProj.title)}`);
			}
		};

		addDescendants(documentId, sanitizeFilename(projected.title));
	}

	const actor = actorForCaller(caller);
	logAudit({ actor, action: 'export_document', targetRecordId: documentId });

	return {
		documentId: projected.id,
		title: projected.title,
		markdown,
		files
	};
}

/** Exports a Collection schema, JSON records, CSV records, and Markdown table. */
export function exportCollection(
	caller: CallerIdentity,
	collectionId: string
): {
	collection: CollectionMeta;
	schemaJson: string;
	recordsJson: string;
	recordsCsv: string;
	markdownTable: string;
} {
	const { collection, records } = queryCollection(caller, collectionId);
	if (!collection) {
		throw new Error(`Collection ${collectionId} not found or inaccessible`);
	}

	const schemaJson = JSON.stringify(collection.schema ?? [], null, 2);
	const recordsJson = JSON.stringify(records, null, 2);
	const recordsCsv = collectionRecordsToCsv(collection.schema ?? [], records);
	const markdownTable = collectionToMarkdownTable(
		collection.title,
		collection.schema ?? [],
		records
	);

	const actor = actorForCaller(caller);
	logAudit({ actor, action: 'export_collection', targetRecordId: collectionId });

	return {
		collection,
		schemaJson,
		recordsJson,
		recordsCsv,
		markdownTable
	};
}

/** Exports all accessible Documents and Collections into a ZIP archive with a manifest. */
export function exportWorkspace(caller: CallerIdentity, spaceId?: string): ExportWorkspaceResult {
	const { workspaceId, defaultSpaceId } = resolveWorkspaceContext();
	const targetSpaceId = spaceId ?? defaultSpaceId;

	const docMetas = listDocuments(caller, spaceId);
	const colMetas = listCollections(caller, spaceId);

	const files: ExportFileEntry[] = [];
	const manifestDocs: WorkspaceManifest['documents'] = [];
	const manifestCols: WorkspaceManifest['collections'] = [];

	// Build document path map
	const docMap = new Map<string, (typeof docMetas)[0]>();
	for (const d of docMetas) {
		if (!docMap.has(d.id)) {
			docMap.set(d.id, d);
		}
	}

	const docPathMap = new Map<string, string>();
	const usedDocPaths = new Set<string>();

	const buildDocPath = (id: string): string => {
		if (docPathMap.has(id)) return docPathMap.get(id)!;
		const meta = docMap.get(id);
		if (!meta) return '';
		const name = sanitizeFilename(meta.title);
		const basePath =
			meta.parentDocumentId && docMap.has(meta.parentDocumentId)
				? `${buildDocPath(meta.parentDocumentId).replace(/\.md$/, '')}/${name}.md`
				: `documents/${name}.md`;

		let fullPath = basePath;
		if (usedDocPaths.has(fullPath)) {
			const ext = path.extname(fullPath);
			const base = fullPath.slice(0, -ext.length);
			fullPath = `${base} (${id})${ext}`;
		}
		usedDocPaths.add(fullPath);
		docPathMap.set(id, fullPath);
		return fullPath;
	};

	for (const meta of docMetas) {
		const docPath = buildDocPath(meta.id);
		const rawDocData = getDocument(caller, meta.id);
		if (!rawDocData) continue;
		const projected = projectDocument(meta.id, rawDocData);
		const mdContent = renderDocumentFileMarkdown(projected.title, projected.records);

		files.push({ path: docPath, content: mdContent });
		manifestDocs.push({
			id: meta.id,
			title: meta.title,
			parentDocumentId: meta.parentDocumentId,
			order: meta.order,
			path: docPath
		});
	}

	const usedColFolders = new Set<string>();
	for (const colMeta of colMetas) {
		let colFolder = `collections/${sanitizeFilename(colMeta.title)}`;
		if (usedColFolders.has(colFolder)) {
			colFolder = `${colFolder} (${colMeta.id})`;
		}
		usedColFolders.add(colFolder);

		const schemaPath = `${colFolder}/schema.json`;
		const recordsPath = `${colFolder}/records.json`;
		const csvPath = `${colFolder}/records.csv`;

		const exportedCol = exportCollection(caller, colMeta.id);
		files.push({ path: schemaPath, content: exportedCol.schemaJson });
		files.push({ path: recordsPath, content: exportedCol.recordsJson });
		files.push({ path: csvPath, content: exportedCol.recordsCsv });

		manifestCols.push({
			id: colMeta.id,
			title: colMeta.title,
			schemaPath,
			recordsPath,
			csvPath
		});
	}

	const manifest: WorkspaceManifest = {
		version: '1.0',
		exportedAt: Date.now(),
		workspaceId,
		spaceId: targetSpaceId,
		documents: manifestDocs,
		collections: manifestCols
	};

	files.unshift({
		path: 'manifest.json',
		content: JSON.stringify(manifest, null, 2)
	});

	// Build zip object for fflate
	const fflateZipInput: Record<string, Uint8Array> = {};
	for (const f of files) {
		fflateZipInput[f.path] = typeof f.content === 'string' ? strToU8(f.content) : f.content;
	}

	const zipBuffer = zipSync(fflateZipInput);

	const actor = actorForCaller(caller);
	logAudit({ actor, action: 'export_workspace' });

	return { manifest, files, zipBuffer };
}

function removeEmptySubdirs(dir: string): void {
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	if (!fs.existsSync(dir)) return;
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const fullSub = path.join(dir, entry.name);
			removeEmptySubdirs(fullSub);
			// eslint-disable-next-line security/detect-non-literal-fs-filename
			if (fs.existsSync(fullSub) && fs.readdirSync(fullSub).length === 0) {
				// eslint-disable-next-line security/detect-non-literal-fs-filename
				fs.rmdirSync(fullSub);
			}
		}
	}
}

function cleanupStaleMirrorFiles(
	resolvedDir: string,
	writtenPaths: Set<string>,
	previousWrittenPaths: Set<string>
): void {
	for (const prevPath of previousWrittenPaths) {
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		if (!writtenPaths.has(prevPath) && fs.existsSync(prevPath)) {
			try {
				// eslint-disable-next-line security/detect-non-literal-fs-filename
				fs.unlinkSync(prevPath);
			} catch {
				// ignore deletion error
			}
		}
	}

	removeEmptySubdirs(resolvedDir);
}

/** Performs a one-directional synchronization of workspace content to the Markdown mirror directory. */
export function syncMarkdownMirror(): {
	synced: boolean;
	fileCount: number;
	outputDir: string;
} {
	const config = getMirrorConfig();
	if (!config.enabled) {
		return { synced: false, fileCount: 0, outputDir: config.outputDir };
	}

	const systemCaller: CallerIdentity = { kind: 'human', userId: 'system' };
	const exportResult = exportWorkspace(systemCaller);

	const resolvedDir = path.isAbsolute(config.outputDir)
		? config.outputDir
		: path.resolve(process.cwd(), config.outputDir);

	// eslint-disable-next-line security/detect-non-literal-fs-filename
	if (!fs.existsSync(resolvedDir)) {
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		fs.mkdirSync(resolvedDir, { recursive: true });
	}

	const writtenPaths = new Set<string>();
	const manifestMarkerPath = path.join(resolvedDir, '.compendium-mirror-manifest.json');
	let previousWrittenPaths = new Set<string>();

	// eslint-disable-next-line security/detect-non-literal-fs-filename
	if (fs.existsSync(manifestMarkerPath)) {
		try {
			// eslint-disable-next-line security/detect-non-literal-fs-filename
			const markerContent = fs.readFileSync(manifestMarkerPath, 'utf-8');
			const parsedMarker = JSON.parse(markerContent);
			if (Array.isArray(parsedMarker.files)) {
				previousWrittenPaths = new Set(parsedMarker.files);
			}
		} catch {
			// ignore read/parse errors for mirror marker
		}
	}

	for (const file of exportResult.files) {
		const filePath = ensurePathInRoot(path.join(resolvedDir, file.path), resolvedDir);
		const fileDir = path.dirname(filePath);
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		if (!fs.existsSync(fileDir)) {
			// eslint-disable-next-line security/detect-non-literal-fs-filename
			fs.mkdirSync(fileDir, { recursive: true });
		}
		if (typeof file.content === 'string') {
			// eslint-disable-next-line security/detect-non-literal-fs-filename
			fs.writeFileSync(filePath, file.content, 'utf-8');
		} else {
			// eslint-disable-next-line security/detect-non-literal-fs-filename
			fs.writeFileSync(filePath, file.content);
		}
		writtenPaths.add(filePath);
	}

	// Clean up only files previously written by the Markdown mirror
	cleanupStaleMirrorFiles(resolvedDir, writtenPaths, previousWrittenPaths);

	// Write new mirror manifest marker
	const mirrorMarkerData = {
		version: '1.0',
		lastSyncedAt: Date.now(),
		files: Array.from(writtenPaths)
	};
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	fs.writeFileSync(manifestMarkerPath, JSON.stringify(mirrorMarkerData, null, 2), 'utf-8');

	return {
		synced: true,
		fileCount: exportResult.files.length,
		outputDir: resolvedDir
	};
}
