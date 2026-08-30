import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import type { DriveFileInfo, DriveFolderInfo, DriveItemKind } from "./drive-types";
import { escapeDriveQueryLiteral } from "./drive-url";

const API_BASE = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const PAGE_SIZE = 100;

export const DRIVE_FOLDER_MIME = FOLDER_MIME;

type RestFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  parents?: string[];
  driveId?: string;
};

type RestList = {
  files?: RestFile[];
  nextPageToken?: string;
};

export type DrivePage<T> = {
  items: T[];
  nextPageToken?: string;
};

function driveError(status: number, body: string): Error {
  return new Error(`Drive API failed: ${status} [http=${status}] ${body.slice(0, 400)}`);
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  let contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    let declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Drive response exceeded the ${maxBytes}-byte limit.`);
    }
  }
  if (!response.body) return new Uint8Array();
  let reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Drive response exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  let bytes = new Uint8Array(total);
  let offset = 0;
  for (let chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toKind(mimeType: string): DriveItemKind {
  return mimeType === FOLDER_MIME ? "folder" : "file";
}

export function toDriveFileInfo(file: RestFile): DriveFileInfo {
  let mimeType = file.mimeType ?? "application/octet-stream";
  let info: DriveFileInfo = {
    id: file.id ?? "",
    name: file.name ?? "Untitled",
    mimeType,
    kind: toKind(mimeType),
  };
  if (file.modifiedTime) info.modifiedTime = new Date(file.modifiedTime);
  if (file.webViewLink) info.webViewLink = file.webViewLink;
  if (file.size) {
    let size = Number(file.size);
    if (Number.isFinite(size)) info.size = size;
  }
  return info;
}

function toFolderInfo(file: RestFile): DriveFolderInfo {
  let info: DriveFolderInfo = {
    id: file.id ?? "",
    name: file.name ?? "Untitled folder",
  };
  if (file.webViewLink) info.webViewLink = file.webViewLink;
  return info;
}

function applySharedDriveParams(url: URL): void {
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
}

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,webViewLink,size,parents,driveId";

export class GoogleDriveApi {
  #getAccessToken: AccessTokenProvider;

  constructor(getAccessToken: AccessTokenProvider) {
    this.#getAccessToken = getAccessToken;
  }

  async #request(url: URL, init: RequestInit = {}): Promise<Response> {
    applySharedDriveParams(url);
    let response = await fetchWithAuthRetry(
      url.toString(),
      { ...init, method: init.method ?? "GET" },
      this.#getAccessToken,
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (!response.ok) {
      let body = new TextDecoder().decode(await readLimited(response, MAX_ERROR_RESPONSE_BYTES));
      throw driveError(response.status, body);
    }
    return response;
  }

  async getFile(fileId: string): Promise<RestFile> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", FILE_FIELDS);
    let response = await this.#request(url);
    return await response.json<RestFile>();
  }

  async getFolder(folderId: string): Promise<DriveFolderInfo> {
    let file = await this.getFile(folderId);
    if ((file.mimeType ?? "") !== FOLDER_MIME) {
      throw new Error("The connected Drive resource is not a folder.");
    }
    return toFolderInfo(file);
  }

  async listPage(q: string, pageToken?: string): Promise<DrivePage<RestFile>> {
    let url = new URL(API_BASE);
    url.searchParams.set("q", q);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("corpora", "allDrives");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let response = await this.#request(url);
    let body = await response.json<RestList>();
    return { items: body.files ?? [], nextPageToken: body.nextPageToken };
  }

  async listChildFolders(folderId: string): Promise<RestFile[]> {
    let q =
      `'${escapeDriveQueryLiteral(folderId)}' in parents and mimeType = '${FOLDER_MIME}' ` +
      "and trashed = false";
    let folders: RestFile[] = [];
    let pageToken: string | undefined;
    do {
      let page = await this.listPage(q, pageToken);
      folders.push(...page.items);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return folders;
  }

  async exportText(fileId: string, mimeType: string): Promise<string> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}/export`);
    url.searchParams.set("mimeType", mimeType);
    let response = await this.#request(url);
    let bytes = await readLimited(response, MAX_DOWNLOAD_BYTES);
    return truncateText(new TextDecoder().decode(bytes));
  }

  async downloadMedia(fileId: string): Promise<Uint8Array> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    let response = await this.#request(url);
    return readLimited(response, MAX_DOWNLOAD_BYTES);
  }
}

export function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + "\n…";
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDE = "application/vnd.google-apps.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function readDriveFileText(
    api: GoogleDriveApi, info: DriveFileInfo): Promise<string | null> {
  if (info.kind === "folder") return null;
  try {
    if (info.mimeType === GOOGLE_DOC || info.mimeType === GOOGLE_SLIDE) {
      return await api.exportText(info.id, "text/plain");
    }
    if (info.mimeType === GOOGLE_SHEET) {
      return await api.exportText(info.id, "text/csv");
    }
    if (info.mimeType.startsWith("text/") || info.mimeType === "application/json") {
      return truncateText(new TextDecoder().decode(await api.downloadMedia(info.id)));
    }
    if (info.mimeType === XLSX) {
      return extractXlsxText(await api.downloadMedia(info.id));
    }
  } catch {
    return null;
  }
  return null;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24);
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  let stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Best-effort text from an xlsx (ZIP) by reading shared strings and sheet XML. */
export async function extractXlsxText(bytes: Uint8Array): Promise<string | null> {
  let entries = await unzipNamed(bytes, [
    "xl/sharedStrings.xml",
    "xl/worksheets/sheet1.xml",
  ]);
  let shared = entries.get("xl/sharedStrings.xml");
  let sheet = entries.get("xl/worksheets/sheet1.xml");
  if (!sheet) return null;
  let strings = shared ? parseSharedStrings(new TextDecoder().decode(shared)) : [];
  return truncateText(sheetXmlToText(new TextDecoder().decode(sheet), strings));
}

async function unzipNamed(
    bytes: Uint8Array, names: string[]): Promise<Map<string, Uint8Array>> {
  let wanted = new Set(names);
  let found = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 30 <= bytes.length && found.size < wanted.size) {
    if (readU32(bytes, offset) !== 0x04034b50) break;
    let method = readU16(bytes, offset + 8);
    let compressed = readU32(bytes, offset + 18);
    let nameLen = readU16(bytes, offset + 26);
    let extraLen = readU16(bytes, offset + 28);
    let nameStart = offset + 30;
    let name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    let dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compressed > bytes.length) break;
    if (wanted.has(name) && compressed >= 0 && compressed < MAX_DOWNLOAD_BYTES) {
      let payload = bytes.subarray(dataStart, dataStart + compressed);
      found.set(name, method === 0 ? payload : await inflate(payload));
    }
    offset = dataStart + compressed;
  }
  return found;
}

function parseSharedStrings(xml: string): string[] {
  let values: string[] = [];
  for (let match of xml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    let texts = [...match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map(t => decodeXml(t[1] ?? ""));
    values.push(texts.join(""));
  }
  return values;
}

function sheetXmlToText(xml: string, shared: string[]): string {
  let rows: string[] = [];
  for (let row of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    let cells: string[] = [];
    for (let cell of row[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      let attrs = cell[1] ?? "";
      let body = cell[2] ?? "";
      let sharedIndex = /t="s"/.test(attrs);
      let value = (body.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1];
      if (value === undefined) {
        cells.push("");
        continue;
      }
      if (sharedIndex) {
        let index = Number(value);
        cells.push(Number.isFinite(index) ? (shared[index] ?? "") : "");
      } else {
        cells.push(decodeXml(value));
      }
    }
    if (cells.some(cell => cell.length > 0)) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export const MAX_FOLDER_TREE = 400;
export const FOLDER_TREE_TTL_MS = 10 * 60 * 1000;

/** Walk nested folders under `rootId`, including the root. Caps the walk to avoid runaway trees. */
export async function collectFolderTree(
    api: GoogleDriveApi, rootId: string, limit = MAX_FOLDER_TREE): Promise<string[]> {
  let ids = [rootId];
  let queue = [rootId];
  while (queue.length > 0 && ids.length < limit) {
    let current = queue.shift()!;
    let children = await api.listChildFolders(current);
    for (let child of children) {
      if (!child.id || ids.includes(child.id)) continue;
      ids.push(child.id);
      queue.push(child.id);
      if (ids.length >= limit) break;
    }
  }
  return ids;
}


export function fileIsUnderFolder(file: RestFile, folderIds: Set<string>): boolean {
  if (file.id && folderIds.has(file.id)) return true;
  return (file.parents ?? []).some(parent => folderIds.has(parent));
}
