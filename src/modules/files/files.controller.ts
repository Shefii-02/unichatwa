import { Body, Controller, Delete, Get, Headers, Param, Query, Req, Res, Post, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { UploadFileDto } from './dto/upload-file.dto';
import { FilesService } from './files.service';

/**
 * File hosting for the Laravel backend: it uploads (admin key) and gets back a public URL; WhatsApp, browsers and the apps then fetch the
 * file from here instead of from Laravel's own disk. Downloads are public — the URL carries an unguessable UUID, like a signed link.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Public origin of this server, for the URL handed back — FILES_PUBLIC_BASE_URL wins, else what the request came in on. */
  private origin(req: Request): string {
    const fixed = (process.env.FILES_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (fixed) return fixed;
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
    return `${proto}://${req.get('host')}`;
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Host a file and get its public URL' })
  async upload(@Body() dto: UploadFileDto, @Req() req: Request) {
    const f = await this.files.save(dto);
    return { key: f.key, url: `${this.origin(req)}/api/${f.path}`, size: f.size, mimetype: f.mimetype };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Delete a hosted file by its key (idempotent)' })
  async remove(@Query('key') key?: string) {
    if (!key) throw new BadRequestException('key is required.');
    await this.files.remove(key);
    return { deleted: true };
  }

  @Get('public/:companyId/:folder/:name')
  @Public()
  @ApiOperation({ summary: 'Download a hosted file (public, unguessable URL)' })
  async download(
    @Param('companyId') companyId: string,
    @Param('folder') folder: string,
    @Param('name') name: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const { bytes, mimetype } = await this.files.read(companyId, folder, name);
    res.setHeader('Content-Type', mimetype);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `${this.files.isInline(mimetype) ? 'inline' : 'attachment'}; filename="${name}"`);

    // players seek in audio / video with a single byte range
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (m && (m[1] !== '' || m[2] !== '')) {
      const size = bytes.length;
      let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      if (start >= size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      start = Math.max(0, start);
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return res.end(bytes.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', String(bytes.length));
    return res.end(bytes);
  }
}
