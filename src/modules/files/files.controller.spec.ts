import 'reflect-metadata';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { PUBLIC_KEY, REQUIRED_ROLE_KEY, UNSCOPED_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

const meta = (key: string, name: keyof FilesController) => Reflect.getMetadata(key, (FilesController.prototype as unknown as Record<string, object>)[name]);

describe('FilesController', () => {
  it('uploading and deleting need an ADMIN key that is not session-restricted', () => {
    for (const h of ['upload', 'remove'] as const) {
      expect(meta(REQUIRED_ROLE_KEY, h)).toBe(ApiKeyRole.ADMIN);
      expect(meta(UNSCOPED_KEY, h)).toBe(true);
    }
  });

  it('only the download is public', () => {
    expect(meta(PUBLIC_KEY, 'download')).toBe(true);
    expect(meta(PUBLIC_KEY, 'upload')).toBeUndefined();
    expect(meta(PUBLIC_KEY, 'remove')).toBeUndefined();
  });

  const res = () => {
    const h: Record<string, string> = {}; let status = 200; let body: Buffer | undefined;
    const r: any = { setHeader: (k: string, v: string) => { h[k] = v; return r; }, status: (s: number) => { status = s; return r; }, end: (b?: Buffer) => { body = b; return r; } };
    return { r, h, get status() { return status; }, get body() { return body; } };
  };
  const svc = (mimetype: string, bytes = Buffer.from('0123456789')) =>
    ({ read: jest.fn().mockResolvedValue({ bytes, mimetype }), isInline: new FilesService({} as never).isInline } as unknown as FilesService);

  it('serves images inline with safe headers and long caching', async () => {
    const o = res(); await new FilesController(svc('image/png')).download('1', 'x', 'n', undefined, o.r);
    expect(o.h['Content-Disposition']).toMatch(/^inline;/);
    expect(o.h['X-Content-Type-Options']).toBe('nosniff');
    expect(o.h['Content-Security-Policy']).toContain("default-src 'none'");
    expect(o.h['Cache-Control']).toContain('immutable');
    expect(o.status).toBe(200);
  });

  it('makes everything else a download', async () => {
    const o = res(); await new FilesController(svc('text/csv')).download('1', 'x', 'n', undefined, o.r);
    expect(o.h['Content-Disposition']).toMatch(/^attachment;/);
  });

  it('answers byte ranges (audio / video seeking) and rejects impossible ones', async () => {
    const c = new FilesController(svc('audio/mpeg'));
    let o = res(); await c.download('1', 'x', 'n', 'bytes=2-5', o.r);
    expect(o.status).toBe(206); expect(o.body?.toString()).toBe('2345'); expect(o.h['Content-Range']).toBe('bytes 2-5/10');
    o = res(); await c.download('1', 'x', 'n', 'bytes=-3', o.r);
    expect(o.body?.toString()).toBe('789');
    o = res(); await c.download('1', 'x', 'n', 'bytes=50-60', o.r);
    expect(o.status).toBe(416);
  });
});
