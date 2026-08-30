/** Parse a Google Drive folder URL into its folder ID, or null if the URL is not a folder. */
export function parseDriveFolderId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "drive.google.com") return null;
  let segments = parsed.pathname.split("/").filter(Boolean);
  // /drive/folders/:id  or  /drive/u/:n/folders/:id
  let foldersAt = segments[0] === "drive" && segments[1] === "folders" ? 2
    : segments[0] === "drive" && segments[1] === "u" && segments[3] === "folders" ? 4
    : -1;
  if (foldersAt < 0) return null;
  let folderId = segments[foldersAt];
  return folderId || null;
}

/** Canonical resource URL for a Drive folder. */
export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

/** Escape a value for a Drive `q` string literal (single-quoted). */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildDriveSearchQuery(query: string, folderIds: string[]): string {
  if (folderIds.length === 0) throw new Error("Drive search requires at least one folder.");
  let tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) throw new Error("Search query must not be empty.");
  let text = tokens
    .map(token => {
      let escaped = escapeDriveQueryLiteral(token);
      return `(name contains '${escaped}' or fullText contains '${escaped}')`;
    })
    .join(" and ");
  let parents = folderIds.map(id => `'${escapeDriveQueryLiteral(id)}' in parents`).join(" or ");
  return `${text} and trashed = false and (${parents})`;
}

export function buildDriveListQuery(folderId: string, nameQuery?: string): string {
  let q = `'${escapeDriveQueryLiteral(folderId)}' in parents and trashed = false`;
  let trimmed = nameQuery?.trim();
  if (trimmed) q += ` and name contains '${escapeDriveQueryLiteral(trimmed)}'`;
  return q;
}

export function chunkIds<T>(items: T[], size: number): T[][] {
  let chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
