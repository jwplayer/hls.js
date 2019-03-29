import TaskLoop from "../task-loop";
import { BufferHelper } from '../utils/buffer-helper';
import Event from '../events';
import EWMA from '../utils/ewma';

const sampleRate: number = 250;

export default class PlaybackRateController extends TaskLoop {
  protected hls: any;
  private config: any;
  private media: any | null = null;
  private ewma: EWMA;
  private latencyTarget: number = 3;
  private refreshLatency = 1;

  constructor(hls) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHING
    );
    this.hls = hls;
    this.config = hls.config;
    this.ewma = new EWMA(hls.config.abrEwmaFastLive);
  }

  onMediaAttached (data) {
    this.media = data.media;
    this.setInterval(sampleRate);
  }

  onMediaDetaching () {
    this.clearInterval();
    this.media = null
  }


  doTick () {
    const { config, latencyTarget, media } = this;
    if (!media) {
      return;
    }
    const pos = media.currentTime;
    const bufferInfo = BufferHelper.bufferInfo(media, pos, config.maxBufferHole);
    const bufferLength = bufferInfo.len;
    const distance = latencyTarget - bufferLength;

    // TODO: Factor amount of forward buffer into refreshLatency
    // TODO: Make slowdowns less drastic, but still allow it to fall back to the target
    if (distance < 0 || distance > this.refreshLatency) {
      media.playbackRate = sigmoid(bufferLength, latencyTarget);
    } else {
      media.playbackRate = 1;
    }
  }
}

const L = 2; // Change playback rate by up to 2x
const k = 0.5;
const sigmoid = (x, x0) => L / (1 + Math.exp(-k * (x - x0)));


// Random TODO: BufferHelper.bufferInfo is used in several classes. Should shift functionality
// into a managed class ala Shaka's playhead controller