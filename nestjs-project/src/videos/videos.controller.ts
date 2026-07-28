import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoStatus } from './entities/video.entity';
import {
  CreateDraftResult,
  VideoDetails,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and start the upload',
    description:
      'Pre-registers the video as a draft owned by the caller channel and initiates a presigned multipart upload.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    return this.videosService.createDraft(
      user.sub,
      dto.title,
      dto.content_type,
      dto.size_bytes,
    );
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the multipart upload and enqueue processing',
    description:
      'Finalizes the multipart upload at the storage provider and enqueues the video for background processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, processing enqueued',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video status and details',
    description:
      "Returns the caller's video current status, duration, and error details when applicable.",
  })
  @ApiResponse({ status: 200, description: 'Video details' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoDetails> {
    return this.videosService.findOwnedById(user.sub, id);
  }
}
