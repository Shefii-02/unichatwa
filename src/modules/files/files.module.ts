import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

/** Hosts files for the Laravel backend (voice replies, invoices, exports…) and serves them by public URL. Storage is the shared StorageService (local or S3). */
@Module({
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
