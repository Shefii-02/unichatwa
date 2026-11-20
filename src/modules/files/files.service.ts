import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StorageService } from '../../common/storage/storage.service';

/** Everything lives under this prefix of the shared media bucket, apart from chat-media/ and statuses. */
export const FILES_PREFIX = 'files/';
/** Default cap on one hosted file (override with FILES_MAX_BYTES). */
export const DEFAULT_FILES_MAX_BYTES = 18 * 1024 * 1024;   // the 25 MB default JSON body limit holds ~18 MB once base64-encoded

/** Extensions we serve with a real type; anything else is stored as .bin and always downloaded, never rendered. */
const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', webm: 'audio/webm',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
  pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};
/** Safe to show in the browser (no script can run from these); everything else is offered as a download. */
const INLINE = /^(image\/(jpeg|png|gif|webp)|audio\/|video\/|application\/pdf)/;
const MIME_TO_EXT: Record<string, string> = Object.fromEntries(Object.entries(TYPES).reverse().map(([e, m]) => [m, e]));

export const NAME_RE = /^[A-Za-z0-9-]{8,40}\.[a-z0-9]{1,8}$/;
export const FOLDER_RE = /^[a-z0-9_-]{1,40}$/;

export interface StoredFile {
  key: string;
  /** Path (under the API prefix) the file is publicly served from. */
  path: string;
  size: number;
  mimetype: string;
}

@Injectable()
export class FilesService {
  constructor(private readonly storage: StorageService) {}

  private maxBytes(): number {
    const n = Number(process.env.FILES_MAX_BYTES);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_FILES_MAX_BYTES;
  }

  private extFor(filename?: string, mimetype?: string): string {
    const fromName = filename?.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
    if (/^[a-z0-9]{1,8}$/.test(fromName) && TYPES[fromName]) return fromName;
    const fromMime = mimetype ? MIME_TO_EXT[mimetype.split(';')[0].trim().toLowerCase()] : undefined;
    return fromMime ?? 'bin';
  }

  /** Decode base64 strictly: garbage used to decode to a few junk bytes and be stored as if it were the file. */
  private decode(data: string): Buffer {
    const s = data.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) throw new BadRequestException('data is not valid base64.');
    const bytes = Buffer.from(s, 'base64');
    const canon = (x: string) => x.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (canon(bytes.toString('base64')) !== canon(s)) throw new BadRequestException('data is not valid base64.');   // truncated / impossible length
    return bytes;
  }

  async save(input: { companyId: number; folder: string; data: string; filename?: string; mimetype?: string }): Promise<StoredFile> {
    if (!FOLDER_RE.test(input.folder)) throw new BadRequestException('Invalid folder.');
    const bytes = this.decode(input.data);
    if (bytes.length === 0) throw new BadRequestException('The file is empty.');
    if (bytes.length > this.maxBytes()) throw new PayloadTooLargeException(`The file is larger than ${Math.floor(this.maxBytes() / 1048576)} MB.`);

    const name = `${randomUUID()}.${this.extFor(input.filename, input.mimetype)}`;
    const rel = `${input.companyId}/${input.folder}/${name}`;
    await this.storage.putFile(`${FILES_PREFIX}${rel}`, bytes);
    return { key: `${FILES_PREFIX}${rel}`, path: `files/public/${rel}`, size: bytes.length, mimetype: this.typeOf(name) };
  }

  typeOf(name: string): string {
    return TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
  }

  isInline(mimetype: string): boolean {
    return INLINE.test(mimetype);
  }

  /** Bytes for a public path, or 404. The three segments are validated so nothing outside files/ can be named. */
  async read(companyId: string, folder: string, name: string): Promise<{ bytes: Buffer; mimetype: string }> {
    if (!/^\d{1,12}$/.test(companyId) || !FOLDER_RE.test(folder) || !NAME_RE.test(name)) throw new NotFoundException();
    try {
      return { bytes: await this.storage.getFile(`${FILES_PREFIX}${companyId}/${folder}/${name}`), mimetype: this.typeOf(name) };
    } catch {
      throw new NotFoundException();
    }
  }

  /** Delete by storage key (as returned by save) — only keys under files/ are accepted. Idempotent. */
  async remove(key: string): Promise<void> {
    const m = /^files\/(\d{1,12})\/([a-z0-9_-]{1,40})\/([A-Za-z0-9-]{8,40}\.[a-z0-9]{1,8})$/.exec(key);
    if (!m) throw new BadRequestException('Not a hosted file key.');
    await this.storage.deleteFile(key);
  }
}
