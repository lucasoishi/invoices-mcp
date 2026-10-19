import { GoogleAuthError, GoogleError, GoogleApiError } from "./auth.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";


export interface AttachmentRef {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** What sync.ts needs from Gmail. Kept as an interface so tests can supply a fake. */
export interface GmailSource {
  listMessageIds(query: string, max: number): Promise<string[]>;
  listAttachments(messageId: string): Promise<AttachmentRef[]>;
  downloadAttachment(ref: AttachmentRef): Promise<Buffer>;
}

interface Part {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: Part[];
}

/**
 * Asks only for the attachment structure of a message, not the body text:
 * the `fields` mask drops `body.data`, so email text is never downloaded.
 */
const LEAF = "filename,mimeType,body(attachmentId,size)";
const FIELDS = `id,payload(${LEAF},parts(${LEAF},parts(${LEAF},parts(${LEAF}))))`;

export class GmailApi implements GmailSource {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async get<T>(pathAndQuery: string): Promise<T> {
    const response = await this.fetchFn(`${BASE}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${await this.getToken()}` },
    });
    if (response.status === 401 || response.status === 403) {
      throw new GoogleAuthError(
        `Gmail refused the request (HTTP ${response.status}). Check that the Gmail API is enabled and re-run auth if needed.`,
      );
    }
    if (!response.ok) throw new GoogleApiError(`Gmail returned an error (HTTP ${response.status}).`);
    return (await response.json()) as T;
  }

  async listMessageIds(query: string, max: number): Promise<string[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(max) });
    const data = await this.get<{ messages?: { id: string }[] }>(`/messages?${params.toString()}`);
    return (data.messages ?? []).map((m) => m.id);
  }

  async listAttachments(messageId: string): Promise<AttachmentRef[]> {
    const params = new URLSearchParams({ fields: FIELDS });
    const data = await this.get<{ payload?: Part }>(`/messages/${encodeURIComponent(messageId)}?format=full&${params.toString()}`);
    const refs: AttachmentRef[] = [];
    const walk = (part: Part | undefined) => {
      if (!part) return;
      if (part.filename && part.body?.attachmentId) {
        refs.push({
          messageId,
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType ?? "",
          size: part.body.size ?? 0,
        });
      }
      for (const child of part.parts ?? []) walk(child);
    };
    walk(data.payload);
    return refs;
  }

  async downloadAttachment(ref: AttachmentRef): Promise<Buffer> {
    const data = await this.get<{ data?: string }>(
      `/messages/${encodeURIComponent(ref.messageId)}/attachments/${encodeURIComponent(ref.attachmentId)}`,
    );
    return Buffer.from(data.data ?? "", "base64url");
  }
}
