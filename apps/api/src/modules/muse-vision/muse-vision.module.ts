import { Module } from '@nestjs/common';
import { MuseVisionService } from './muse-vision.service';

/** Meta Muse vision: one file in, validated JSON out. Used by the CDL and RC readers. */
@Module({
  providers: [MuseVisionService],
  exports: [MuseVisionService],
})
export class MuseVisionModule {}
