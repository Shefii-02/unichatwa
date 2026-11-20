import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A file a trusted server (the Laravel backend) wants hosted here, shared by public URL. */
export class UploadFileDto {
  @ApiProperty({ description: 'Owning company id — the file is stored and addressed under it.', example: 12 })
  @IsInt()
  @Min(1)
  companyId!: number;

  @ApiProperty({ description: 'What the file is for (a short folder name): voice-replies, invoices, exports…', example: 'voice-replies' })
  @IsString()
  @Matches(/^[a-z0-9_-]{1,40}$/, { message: 'folder must be 1-40 lowercase letters, digits, "-" or "_"' })
  folder!: string;

  @ApiProperty({ description: 'Base64-encoded file bytes.' })
  @IsString()
  @IsNotEmpty()
  data!: string;

  @ApiPropertyOptional({ description: 'Original file name — only its extension is used.', example: 'invoice.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({ description: 'MIME type, used for the extension when the file name has none.', example: 'audio/mpeg' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimetype?: string;
}
