import { RemuxedTrack, Remuxer, RemuxerResult } from '../types/remuxer';
import { getDuration, getStartDTS, offsetStartDTS, parseInitSegment, InitData } from '../utils/mp4-tools';
import { TrackSet } from '../types/track';
import { logger } from '../utils/logger';

class PassThroughRemuxer implements Remuxer {
  private emitInitSegment: boolean = false;
  private audioCodec?: string;
  private videoCodec?: string;
  private initData?: InitData;
  private initPTS?: number;
  private initTracks?: TrackSet;
  private lastEndDTS: number | null = null;

  destroy () {
  }

  resetTimeStamp (defaultInitPTS) {
    this.initPTS = defaultInitPTS;
    this.lastEndDTS = null;
  }

  resetNextTimestamp () {
    this.lastEndDTS = null;
  }

  resetInitSegment (initSegment, audioCodec, videoCodec) {
    this.audioCodec = audioCodec;
    this.videoCodec = videoCodec;
    this.generateInitSegment(initSegment);
    this.emitInitSegment = true;
  }

  generateInitSegment (initSegment): void {
    let { audioCodec, videoCodec } = this;
    if (!initSegment || !initSegment.byteLength) {
      this.initTracks = undefined;
      this.initData = undefined;
      return;
    }
    const initData = this.initData = parseInitSegment(initSegment);

    // default audio codec if nothing specified
    // TODO : extract that from initsegment
    if (!audioCodec) {
      audioCodec = 'mp4a.40.5';
    }

    if (!videoCodec) {
      videoCodec = 'avc1.42e01e';
    }

    const tracks: TrackSet = {};
    if (initData.audio && initData.video) {
      tracks.audiovideo = {
        container: 'video/mp4',
        codec: audioCodec + ',' + videoCodec,
        initSegment,
        id: 'main'
      };
    } else {
      if (initData.audio) {
        tracks.audio = { container: 'audio/mp4', codec: audioCodec, initSegment, id: 'audio' };
      }

      if (initData.video) {
        tracks.video = { container: 'video/mp4', codec: videoCodec, initSegment, id: 'main' };
      }
    }
    this.initTracks = tracks;
  }

  // TODO: utilize accurateTimeOffset
  remux (audioTrack, videoTrack, id3Track, textTrack, timeOffset, accurateTimeOffset: boolean): RemuxerResult {
    let { initPTS, lastEndDTS } = this;
    const result: RemuxerResult = {
      audio: undefined,
      video: undefined,
      text: textTrack,
      id3: id3Track,
      initSegment: undefined
    };

    // If we haven't yet set a lastEndDTS, or it was reset, set it to the provided timeOffset. We want to use the
    // lastEndDTS over timeOffset whenever possible; during progressive playback, the media source will not update
    // the media duration (which is what timeOffset is provided as) before we need to process the next chunk.
    if (!Number.isFinite(lastEndDTS!)) {
      lastEndDTS = this.lastEndDTS = timeOffset || 0;
    }

    // The binary segment data is added to the videoTrack in the mp4demuxer. We don't check to see if the data is only
    // audio or video (or both); adding it to video was an arbitrary choice.
    const data = videoTrack.samples;
    if (!data || !data.length) {
      return result;
    }

    let initData = this.initData;
    if (!initData || !initData.length) {
      this.generateInitSegment(data);
      initData = this.initData;
    }
    if (!initData || !initData.length) {
      // We can't remux if the initSegment could not be generated
      logger.warn('[passthrough-remuxer.ts]: Failed to generate initSegment.');
      return result;
    }
    if (this.emitInitSegment) {
      result.initSegment = {
        tracks: this.initTracks,
        initPTS: initPTS || 0
      };
      this.emitInitSegment = false;
    }

    if (!Number.isFinite(initPTS as number)) {
      this.initPTS = initPTS = computeInitPTS(initData, data, timeOffset);
      if (result.initSegment) {
        result.initSegment.initPTS = initPTS;
      }
    }

    const duration = getDuration(data, initData);
    console.assert(duration > 0, 'Duration parsed from mp4 should be greater than zero');

    const startDTS = lastEndDTS as number;
    const endDTS = duration + startDTS;
    console.log('remux before buffer startDTS', startDTS, endDTS, 'lastEndDTS', lastEndDTS, 'initPTS', initPTS);

    const baseMediaDecodeTimes = offsetStartDTS(initData, data, initPTS);
    if (Math.abs(baseMediaDecodeTimes[0] - startDTS) > 1) {
      // debugger;
    }
    this.lastEndDTS = endDTS;

    const hasAudio = !!initData.audio;
    const hasVideo = !!initData.video;

    let type: any = '';
    if (hasAudio) {
      type += 'audio';
    }

    if (hasVideo) {
      type += 'video';
    }

    const track: RemuxedTrack = {
      data1: data,
      startPTS: startDTS,
      startDTS,
      endPTS: endDTS,
      endDTS,
      type,
      hasAudio,
      hasVideo,
      nb: 1,
      dropped: 0,
      baseMediaDecodeTimes
    };

    if (track.type === 'audio') {
      result.audio = track;
    } else {
      result.video = track;
    }

    return result;
  }
}

const computeInitPTS = (initData, data, timeOffset) => getStartDTS(initData, data) - timeOffset;

export default PassThroughRemuxer;
