import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { FilesService } from './files.service';
import type { StorageService } from '../../common/storage/storage.service';

class FakeStorage {
  files = new Map<string, Buffer>();
  async putFile(k: string, d: Buffer) { this.files.set(k, d); }
  async getFile(k: string) { const f = this.files.get(k); if (!f) throw new Error('missing'); return f; }
  async deleteFile(k: string) { this.files.delete(k); }
}
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('FilesService', () => {
  let storage: FakeStorage; let svc: FilesService;
  beforeEach(() => { storage = new FakeStorage(); svc = new FilesService(storage as unknown as StorageService); delete process.env.FILES_MAX_BYTES; });

  it('stores under files/{company}/{folder}/{uuid}.{ext} and returns a public path', async () => {
    const f = await svc.save({ companyId: 12, folder: 'invoices', data: b64('%PDF'), filename: 'Invoice 7.PDF' });
    expect(f.key).toMatch(/^files\/12\/invoices\/[0-9a-f-]{36}\.pdf$/);
    expect(f.path).toBe(f.key.replace('files/', 'files/public/'));
    expect(f.mimetype).toBe('application/pdf');
    expect(f.size).toBe(4);
    expect(storage.files.get(f.key)?.toString()).toBe('%PDF');
  });

  it('takes the extension from the mime type when the name has none', async () => {
    expect((await svc.save({ companyId: 1, folder: 'voice-replies', data: b64('x'), mimetype: 'audio/mpeg' })).key).toMatch(/\.mp3$/);
  });

  it('never trusts a dangerous extension: html / svg / js are stored as .bin and always downloaded', async () => {
    for (const filename of ['x.html', 'x.svg', 'x.js', 'x.php']) {
      const f = await svc.save({ companyId: 1, folder: 'exports', data: b64('<script>'), filename });
      expect(f.key).toMatch(/\.bin$/);
      expect(f.mimetype).toBe('application/octet-stream');
      expect(svc.isInline(f.mimetype)).toBe(false);
    }
  });

  it('shows only safe types inline', () => {
    expect(['image/png', 'audio/mpeg', 'video/mp4', 'application/pdf'].every((m) => svc.isInline(m))).toBe(true);
    expect(['text/csv', 'text/html', 'image/svg+xml', 'application/zip'].some((m) => svc.isInline(m))).toBe(false);
  });

  it('refuses empty and oversized files, and a bad folder', async () => {
    await expect(svc.save({ companyId: 1, folder: 'a', data: '' })).rejects.toBeInstanceOf(BadRequestException);
    process.env.FILES_MAX_BYTES = '3';
    await expect(svc.save({ companyId: 1, folder: 'a', data: b64('abcd') })).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(svc.save({ companyId: 1, folder: '../etc', data: b64('a') })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects data that is not base64 instead of storing junk, but accepts padded, wrapped and url-safe base64', async () => {
    for (const bad of ['!!!not base64 at all!!!', 'abc$', 'YQ=a', 'A', '====']) {
      await expect(svc.save({ companyId: 1, folder: 'a', data: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x01, 0x02]);
    for (const good of [bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('base64').replace(/(.{4})/g, '$1\n')]) {
      const f = await svc.save({ companyId: 1, folder: 'a', data: good, filename: 'x.bin' });
      expect(storage.files.get(f.key)?.equals(bytes)).toBe(true);
    }
  });

  it('reads back what it stored and 404s on anything malformed (no path traversal)', async () => {
    const f = await svc.save({ companyId: 5, folder: 'exports', data: b64('a,b'), filename: 'x.csv' });
    const [, , company, folder, name] = f.path.split('/');
    expect((await svc.read(company, folder, name)).bytes.toString()).toBe('a,b');
    for (const bad of [['5', 'exports', '../../secret.pdf'], ['5', '..', name], ['x', 'exports', name], ['5', 'exports', 'short.pdf'], ['5', 'exports', name + '/..']]) {
      await expect(svc.read(bad[0], bad[1], bad[2])).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(svc.read('6', 'exports', name)).rejects.toBeInstanceOf(NotFoundException);   // another company's path
  });

  it('deletes only keys it handed out, and deleting twice is fine', async () => {
    const f = await svc.save({ companyId: 2, folder: 'exports', data: b64('x'), filename: 'x.csv' });
    await svc.remove(f.key);
    expect(storage.files.has(f.key)).toBe(false);
    await expect(svc.remove(f.key)).resolves.toBeUndefined();
    for (const bad of ['chat-media/1/abc', 'files/../x', 'files/1/exports/../../x.pdf', '', 'media/files/1/a/b.pdf']) {
      await expect(svc.remove(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
