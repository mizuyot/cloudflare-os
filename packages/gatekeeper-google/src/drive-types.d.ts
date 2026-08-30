import { Cursor } from "@gadgets/workshop-shared/gatekeeper";

export type { Cursor };

/** Whether a Drive item is a file or a folder. */
export type DriveItemKind = "file" | "folder";

/** Metadata about a file or folder in the connected Drive folder. */
export type DriveFileInfo = {
  /** Stable Drive file ID. */
  id: string;
  /** File or folder name. */
  name: string;
  /** Drive MIME type, e.g. "application/vnd.google-apps.spreadsheet". */
  mimeType: string;
  kind: DriveItemKind;
  /** Last modification time, when Drive reports one. */
  modifiedTime?: Date;
  /** URL that opens this item in the Drive / Docs / Sheets UI. */
  webViewLink?: string;
  /** Size in bytes for binary files, when known. Absent for Google-native files. */
  size?: number;
};

/** Metadata about the connected Drive folder. */
export type DriveFolderInfo = {
  /** Stable Drive folder ID. */
  id: string;
  /** Folder name. */
  name: string;
  /** URL that opens this folder in Drive. */
  webViewLink?: string;
};

/** One item from a listing or search, with a capability to read it when it is a file. */
export type DriveItemEntry = {
  info: DriveFileInfo;
  /** Present for files (not folders). Dispose it when finished. */
  file?: GoogleDriveFile;
};

/**
 * Read-only access to one selected Google Drive folder and the files inside it
 * (including nested folders).
 */
export interface GoogleDriveFolderSession {
  /** Return metadata for the connected folder. */
  getInfo(): Promise<DriveFolderInfo>;

  /**
   * List direct children of the connected folder, most recently modified first.
   * When `query` is set, only children whose names contain that text are returned.
   */
  list(opts?: { query?: string }): Promise<Cursor<DriveItemEntry>>;

  /**
   * Search files under this folder (including nested folders) by name and indexed
   * file contents. The query must be non-empty. Results are the files Drive
   * considers a match; some file types (especially PDFs) may appear here even
   * when `readText()` cannot return their contents.
   */
  search(query: string): Promise<Cursor<DriveItemEntry>>;

  /**
   * Get a capability to a file under this folder by its Drive file ID.
   * Throws if the file is not inside the connected folder. Dispose it when finished.
   */
  getFile(fileId: string): Promise<GoogleDriveFile>;
}

/** Read-only access to one file inside a connected Drive folder. */
export interface GoogleDriveFile {
  /** Return file metadata (name, type, modified time, open URL). */
  getMetadata(): Promise<DriveFileInfo>;

  /**
   * Return a text rendering of the file when one can be produced, otherwise null.
   * Google Docs and Slides become plain text, Google Sheets become CSV, and
   * ordinary text / CSV / Excel (.xlsx) files return extracted text. PDFs and
   * other binary types return null — use `getMetadata().webViewLink` to open them.
   */
  readText(): Promise<string | null>;
}
