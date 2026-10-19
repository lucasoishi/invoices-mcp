import { GoogleApiError, GoogleAuthError, GoogleError } from "./auth.js";

const FILES = "https://www.googleapis.com/drive/v3/files";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parents: string[];
}

/** What drive-sync.ts needs from Drive. An interface so tests can supply a fake. */
export interface DriveSource {
  listFolder(folderId: string, max: number): Promise<DriveFile[]>;
  download(file: DriveFile): Promise<Buffer>;
}

/** A folder id, or a folder URL like drive.google.com/drive/folders/<id>, -> the id. */
export function parseFolderId(input: string): string {
  const trimmed = input.trim();
  const fromUrl = /\/folders\/([A-Za-z0-9_-]+)/.exec(trimmed)?.[1];
  const id = fromUrl ?? trimmed;
  assertFolderId(id);
  return id;
}

export function assertFolderId(id: string): void {
  // The id is interpolated into a search query, so it must be a plain Drive id and nothing else.
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) {
    throw new GoogleError("The Drive folder must be a folder id or a drive.google.com/drive/folders/... link.");
  }
}

const FIELDS = "nextPageToken,files(id,name,mimeType,size,parents)";
const DRIVE_DISABLED =
  "The Google Drive API is not enabled for your Google Cloud project. Enable it at " +
  "console.cloud.google.com/apis/library/drive.googleapis.com and try again.";

/** Read-only: every request is a GET, and files are never modified, moved, shared or trashed. */
export class DriveApi implements DriveSource {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async get(url: string): Promise<Response> {
    const response = await this.fetchFn(url, { headers: { authorization: `Bearer ${await this.getToken()}` } });
    if (response.status === 401) {
      throw new GoogleAuthError("Google refused the request (HTTP 401). Run auth again.");
    }
    if (response.status === 403) {
      const detail = await response.text().catch(() => "");
      if (/accessNotConfigured|has not been used in project|SERVICE_DISABLED/.test(detail)) throw new GoogleAuthError(DRIVE_DISABLED);
      throw new GoogleAuthError("Google refused the request (HTTP 403). Check that Drive access was authorised with: invoices-mcp auth --scopes gmail,drive");
    }
    if (response.status === 404) throw new GoogleApiError("Drive could not find that folder or file (HTTP 404). Check the folder id and that this Google account can open it.");
    if (!response.ok) throw new GoogleApiError(`Drive returned an error (HTTP ${response.status}).`);
    return response;
  }

  async listFolder(folderId: string, max: number): Promise<DriveFile[]> {
    assertFolderId(folderId);
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: FIELDS,
        orderBy: "createdTime desc",
        pageSize: String(Math.min(100, Math.max(1, max - files.length))),
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = (await (await this.get(`${FILES}?${params.toString()}`)).json()) as {
        files?: { id: string; name: string; mimeType?: string; size?: string; parents?: string[] }[];
        nextPageToken?: string;
      };
      for (const f of data.files ?? []) {
        files.push({ id: f.id, name: f.name, mimeType: f.mimeType ?? "", size: Number(f.size ?? 0), parents: f.parents ?? [] });
      }
      pageToken = data.nextPageToken;
    } while (pageToken && files.length < max);
    return files.slice(0, max);
  }

  async download(file: DriveFile): Promise<Buffer> {
    const response = await this.get(`${FILES}/${encodeURIComponent(file.id)}?alt=media`);
    return Buffer.from(await response.arrayBuffer());
  }
}
