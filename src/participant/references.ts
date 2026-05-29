/**
 * Reference extraction utilities for VSCode ChatRequest.
 *
 * Converts VSCode `ChatPromptReference` values (images, file URIs,
 * code locations) into ACP `AcpFileAttachment` objects that can be
 * passed to the OpenCode backend alongside the user prompt.
 *
 * @module
 */
import * as vscode from 'vscode';
import type { AcpFileAttachment } from '../acp/types';

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/jsx',
  '.ts': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-cpp',
  '.css': 'text/css',
  '.scss': 'text/scss',
  '.html': 'text/html',
  '.sh': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  '.swift': 'text/x-swift',
  '.kt': 'text/x-kotlin',
  '.lua': 'text/x-lua',
};

function guessMimeFromExt(fsPath: string): string {
  const ext = fsPath.slice(fsPath.lastIndexOf('.')).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Safe JSON inspection helper
// ---------------------------------------------------------------------------

/** Safely stringify a value for debug logging (handles circular refs, errors) */
function safeInspect(value: unknown, maxLen = 300): string {
  if (value === null) {return 'null';}
  if (value === undefined) {return 'undefined';}
  if (typeof value === 'string') {
    const s = value.length > 120 ? value.slice(0, 120) + '…' : value;
    return `string(${value.length})="${s}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {return String(value);}
  if (typeof value === 'object') {
    try {
      const seen = new Set<unknown>();
      const json = JSON.stringify(value, (_, v) => {
        if (v !== null && typeof v === 'object') {
          if (seen.has(v)) {return '[Circular]';}
          seen.add(v);
        }
        if (typeof v === 'string' && v.length > 200) {return v.slice(0, 200) + '…';}
        return v;
      }, 2);
      if (json && json.length > maxLen) {
        return json.slice(0, maxLen) + '\n…(truncated)';
      }
      return json ?? '{}';
    } catch {
      return `{ctor=${(value as object).constructor?.name ?? '?'}}`;
    }
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Uri extraction — try every possible shape
// ---------------------------------------------------------------------------

interface UriRef {
  url: string;
  fsPath: string;
  scheme: string;
}

/**
 * Try every conceivable way to extract a `file://` URI reference from
 * an unknown value.  Returns `{ url, fsPath, scheme }` or `undefined`.
 *
 * Order of attempts:
 *  1. `instanceof vscode.Uri` (genuine Uri instances)
 *  2. Duck-type: plain object with string `scheme` + `fsPath`/`path`
 *  3. Duck-type: object with `.uri` sub-property that is itself a Uri
 *  4. Duck-type: object with a `url` or `filePath` own string property
 *  5. Duck-type: stringifiable value containing a `file:///` URL
 */
function extractUriRef(value: unknown, logger?: { appendLine(m: string ): void }): UriRef | undefined {
  if (value === null || value === undefined) {return undefined;}

  // --- 1. instanceof vscode.Uri ---
  if (value instanceof vscode.Uri) {
    logger?.appendLine(`[ref]  → instanceof vscode.Uri: scheme=${value.scheme} fsPath=${value.fsPath}`);
    if (value.scheme === 'file') {
      return { url: value.toString(true), fsPath: value.fsPath, scheme: 'file' };
    }
    return undefined;
  }

  if (typeof value !== 'object') {
    // --- 5. string value ---
    if (typeof value === 'string') {
      logger?.appendLine(`[ref]  → string value: "${value.slice(0, 100)}"`);
      return extractUriFromString(value, logger);
    }
    return undefined;
  }

  const obj = value as Record<string, unknown>;
  logger?.appendLine(`[ref]  → object: ctor=${(obj).constructor?.name ?? '?'} keys=[${Object.keys(obj).slice(0, 10).join(', ')}]`);

  // --- 2. Duck-type Uri: { scheme, fsPath/path } ---
  if (typeof obj.scheme === 'string') {
    const fsPath = typeof obj.fsPath === 'string' ? obj.fsPath : (typeof obj.path === 'string' ? obj.path : undefined);
    if (fsPath && typeof fsPath === 'string') {
      logger?.appendLine(`[ref]  → duck-type Uri: scheme=${obj.scheme} fsPath=${fsPath}`);
      if (obj.scheme === 'file') {
        const url = typeof obj.toString === 'function'
          ? String((obj as { toString(skip?: boolean): string }).toString(true))
          : `file://${fsPath.replace(/\\/g, '/')}`;
        return { url, fsPath, scheme: 'file' };
      }
      return undefined;
    }
  }

  // --- 3. Location-like: { uri, range } ---
  if ('uri' in obj && 'range' in obj) {
    logger?.appendLine(`[ref]  → Location-like object`);
    return extractUriRef(obj.uri, logger);
  }

  // --- 4. Image attachment: { mimeType, data, reference } ---
  // VSCode passes pasted images as objects with { mimeType, data (ArrayBuffer/Uint8Array), reference (Uri) }
  const mimeType = obj.mimeType;
  const imgData = obj.data;
  if (typeof mimeType === 'string' && imgData !== undefined) {
    logger?.appendLine(`[ref]  → image attachment: mimeType=${mimeType} dataType=${typeof imgData} ctor=${(imgData as object)?.constructor?.name ?? '?'}`);
    // Convert the binary data to a data: URI
    const dataUri = binaryToDataUri(imgData as unknown, mimeType as string, logger);
    if (dataUri) {
      return { url: dataUri, fsPath: `pasted.${mimeType.split('/')[1] ?? 'bin'}`, scheme: 'data' };
    }
    // If data URI conversion failed, try the reference field
    if ('reference' in obj) {
      logger?.appendLine(`[ref]  → falling back to .reference field`);
      return extractUriRef(obj.reference, logger);
    }
    return undefined;
  }

  // --- 5. Object with url/filePath string properties ---
  if (typeof obj.url === 'string' && obj.url.length > 0) {
    logger?.appendLine(`[ref]  → has .url property: "${obj.url.slice(0, 100)}"`);
    return extractUriFromString(obj.url, logger);
  }
  if (typeof obj.filePath === 'string' && obj.filePath.length > 0) {
    logger?.appendLine(`[ref]  → has .filePath property: "${obj.filePath.slice(0, 100)}"`);
    return extractUriFromString(obj.filePath, logger);
  }
  if (typeof obj.path === 'string' && obj.path.length > 0) {
    logger?.appendLine(`[ref]  → has .path property: "${obj.path.slice(0, 100)}"`);
    return extractUriFromString(obj.path, logger);
  }

  // --- Fallback: JSON-inspect for file:// patterns ---
  const inspected = safeInspect(value);
  const fileMatch = inspected.match(/file:\/\/\/?[^\s"'}),]+/);
  if (fileMatch) {
    logger?.appendLine(`[ref]  → found file:// pattern in JSON: ${fileMatch[0].slice(0, 100)}`);
    return extractUriFromString(fileMatch[0], logger);
  }

  logger?.appendLine(`[ref]  → could not extract URI from value`);
  return undefined;
}

/**
 * Try to parse a string as a file:// URI or file path.
 */
function extractUriFromString(str: string, logger?: { appendLine(m: string ): void }): UriRef | undefined {
  const trimmed = str.trim();

  // file:// URI
  if (trimmed.startsWith('file://')) {
    const pathPart = trimmed.replace(/^file:\/\//, '');
    // Decode percent-encoded chars
    const fsPath = decodeURIComponent(pathPart);
    logger?.appendLine(`[ref]  → parsed file:// URI: fsPath=${fsPath}`);
    return { url: trimmed, fsPath, scheme: 'file' };
  }

  // data: URI
  if (trimmed.startsWith('data:')) {
    const semi = trimmed.indexOf(';');
    const comma = trimmed.indexOf(',');
    const mime = semi > 0 ? trimmed.slice(5, semi) : (comma > 0 ? trimmed.slice(5, comma) : 'application/octet-stream');
    logger?.appendLine(`[ref]  → data: URI (mime=${mime}, len=${trimmed.length})`);
    return { url: trimmed, fsPath: `data.${mime.split('/')[1] ?? 'bin'}`, scheme: 'data' };
  }

  // Absolute file path (Windows or Unix)
  if ((trimmed.startsWith('/') || trimmed.match(/^[a-zA-Z]:\\/)) && trimmed.length > 3) {
    const fsPath = trimmed;
    const url = fsPath.startsWith('/') ? `file://${fsPath}` : `file:///${fsPath.replace(/\\/g, '/')}`;
    logger?.appendLine(`[ref]  → absolute path: fsPath=${fsPath}`);
    return { url, fsPath, scheme: 'file' };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Binary-to-data-URI converter
// ---------------------------------------------------------------------------

/**
 * Convert a binary data value (ArrayBuffer, Uint8Array, or base64 string)
 * to a `data:` URI string.
 */
function binaryToDataUri(data: unknown, mimeType: string, logger?: { appendLine(m: string ): void }): string | undefined {
  if (!data) {return undefined;}

  // --- Uint8Array / Int8Array ---
  if (data instanceof Uint8Array || data instanceof Int8Array) {
    logger?.appendLine(`[ref]  → converting ${data.constructor.name} (${data.byteLength} bytes) to data URI`);
    const base64 = Buffer.from(data.buffer || data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  // --- ArrayBuffer ---
  if (data instanceof ArrayBuffer) {
    logger?.appendLine(`[ref]  → converting ArrayBuffer (${data.byteLength} bytes) to data URI`);
    const base64 = Buffer.from(data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  // --- Array-like (e.g. number[]) ---
  if (Array.isArray(data)) {
    logger?.appendLine(`[ref]  → converting Array[${data.length}] to data URI`);
    const base64 = Buffer.from(data.map(b => (typeof b === 'number' ? b : 0) & 0xff)).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  // --- string (already base64) ---
  if (typeof data === 'string') {
    logger?.appendLine(`[ref]  → using string data (len=${data.length}) directly as base64`);
    return `data:${mimeType};base64,${data}`;
  }

  logger?.appendLine(`[ref]  → unsupported data type: ${typeof data}`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a single `AcpFileAttachment` from a `ChatPromptReference.value`.
 *
 * Returns `undefined` if the value is not a file/image reference.
 */
export function extractAttachmentFromReference(
  value: unknown,
  logger?: { appendLine(m: string): void },
): AcpFileAttachment | undefined {
  const ref = extractUriRef(value, logger);
  if (!ref) {return undefined;}

  const filename = ref.fsPath.split(/[/\\]/).pop() || undefined;
  const mime = guessMimeFromExt(ref.fsPath);

  logger?.appendLine(`[ref]  → attachment: mime=${mime} file=${filename}`);

  return { mime, filename, url: ref.url };
}

/**
 * Extract all file attachments from a VSCode `ChatRequest.references` array.
 *
 * @param references - The `ChatRequest.references` array.
 * @param logger     - Optional logger for debug output.
 * @returns Deduplicated list of `AcpFileAttachment` objects.
 */
export function extractAttachmentsFromReferences(
  references: readonly { readonly value: unknown }[] | undefined,
  logger?: { appendLine(m: string): void },
): AcpFileAttachment[] {
  if (!references || references.length === 0) {
    logger?.appendLine('[ref] No references');
    return [];
  }

  logger?.appendLine(`[ref] Processing ${references.length} reference(s)`);

  const seen = new Set<string>();
  const attachments: AcpFileAttachment[] = [];

  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    logger?.appendLine(`[ref] ref[${i}] id="${ref.id}" range=[${ref.range?.[0] ?? '-'},${ref.range?.[1] ?? '-'}]`);

    const attachment = extractAttachmentFromReference(ref.value, logger);
    if (attachment) {
      if (!seen.has(attachment.url)) {
        seen.add(attachment.url);
        attachments.push(attachment);
        logger?.appendLine(`[ref]  ✓ added: ${attachment.url}`);
      } else {
        logger?.appendLine('[ref]  − duplicate, skipped');
      }
    }
  }

  if (attachments.length > 0) {
    logger?.appendLine(`[ref] Total: ${attachments.length} attachment(s) extracted`);
  } else {
    logger?.appendLine('[ref] No attachments extracted');
  }

  return attachments;
}
