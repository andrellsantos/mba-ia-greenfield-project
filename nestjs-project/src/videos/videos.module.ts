import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { StorageService } from './storage.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  providers: [StorageService],
  exports: [TypeOrmModule, StorageService],
})
export class VideosModule {}
