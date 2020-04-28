import { Events } from '../events';
import Cea608Parser, { CaptionScreen } from '../utils/cea-608-parser';
import OutputFilter from '../utils/output-filter';
import WebVTTParser from '../utils/webvtt-parser';
import { logger } from '../utils/logger';
import { sendAddTrackEvent, clearCurrentCues } from '../utils/texttrack-utils';
import Fragment from '../loader/fragment';
import { HlsConfig } from '../config';
import { parseIMSC1, IMSC1_CODEC } from '../utils/imsc1-ttml-parser';
import { CuesInterface } from '../utils/cues';
import { MediaPlaylist } from '../types/media-playlist';
import Hls from '../hls';
import { FragParsingUserdataData, FragLoadedData, FragDecryptedData, MediaAttachingData, ManifestLoadedData, InitPTSFoundData } from '../types/events';
import { ComponentAPI } from '../types/component-api';

type TrackProperties = {
  label: string,
  languageCode: string,
  media?: MediaPlaylist
};

type NonNativeCaptionsTrack = {
  _id?: string,
  label: string,
  kind: string,
  default: boolean,
  closedCaptions?: MediaPlaylist,
  subtitleTrack?: MediaPlaylist
};

type VTTCCs = {
  ccOffset: number,
  presentationOffset: number,
  [key: number]: {
    start: number,
    prevCC: number,
    new: boolean
  }
};

class TimelineController implements ComponentAPI {
  private hls: Hls;
  private media: HTMLMediaElement | null = null;
  private config: HlsConfig;
  private enabled: boolean = true;
  private Cues: CuesInterface;
  private textTracks: Array<TextTrack> = [];
  private tracks: Array<MediaPlaylist> = [];
  private initPTS: Array<number> = [];
  private unparsedVttFrags: Array<FragLoadedData | FragDecryptedData> = [];
  private cueRanges: Record<string, Array<[number, number]>> = {};
  private captionsTracks: Record<string, TextTrack> = {};
  private nonNativeCaptionsTracks: Record<string, NonNativeCaptionsTrack> = {};
  private cea608Parser?: Cea608Parser;
  private lastSn: number = -1;
  private prevCC: number = -1;
  private vttCCs: VTTCCs = newVTTCCs();
  private captionsProperties: {
    textTrack1: TrackProperties
    textTrack2: TrackProperties
    textTrack3: TrackProperties
    textTrack4: TrackProperties
  };

  constructor (hls: Hls) {
    this.hls = hls;
    this.config = hls.config;
    this.Cues = hls.config.cueHandler;

    this.captionsProperties = {
      textTrack1: {
        label: this.config.captionsTextTrack1Label,
        languageCode: this.config.captionsTextTrack1LanguageCode
      },
      textTrack2: {
        label: this.config.captionsTextTrack2Label,
        languageCode: this.config.captionsTextTrack2LanguageCode
      },
      textTrack3: {
        label: this.config.captionsTextTrack3Label,
        languageCode: this.config.captionsTextTrack3LanguageCode
      },
      textTrack4: {
        label: this.config.captionsTextTrack4Label,
        languageCode: this.config.captionsTextTrack4LanguageCode
      }
    };

    if (this.config.enableCEA708Captions) {
      const channel1 = new OutputFilter(this, 'textTrack1');
      const channel2 = new OutputFilter(this, 'textTrack2');
      const channel3 = new OutputFilter(this, 'textTrack3');
      const channel4 = new OutputFilter(this, 'textTrack4');
      this.cea608Parser = new Cea608Parser(channel1, channel2, channel3, channel4);
    }

    this._registerListeners();
  }

  private _registerListeners (): void {
    const { hls } = this;
    hls.on(Events.MEDIA_ATTACHING, this.onMediaAttaching, this);
    hls.on(Events.MEDIA_DETACHING, this.onMediaDetaching, this);
    hls.on(Events.FRAG_PARSING_USERDATA, this.onFragParsingUserdata, this);
    hls.on(Events.FRAG_DECRYPTED, this.onFragDecrypted, this);
    hls.on(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.on(Events.MANIFEST_LOADED, this.onManifestLoaded, this);
    hls.on(Events.FRAG_LOADED, this.onFragLoaded, this);
    hls.on(Events.INIT_PTS_FOUND, this.onInitPtsFound, this);
    hls.on(Events.FRAG_PARSING_INIT_SEGMENT, this.onFragParsingInitSegment, this);
    hls.on(Events.SUBTITLE_TRACKS_CLEARED, this.onSubtitleTracksCleared, this);
  }

  private _unregisterListeners (): void {
    const { hls } = this;
    hls.off(Events.MEDIA_ATTACHING, this.onMediaAttaching, this);
    hls.off(Events.MEDIA_DETACHING, this.onMediaDetaching, this);
    hls.off(Events.FRAG_PARSING_USERDATA, this.onFragParsingUserdata, this);
    hls.off(Events.FRAG_DECRYPTED, this.onFragDecrypted, this);
    hls.off(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.off(Events.MANIFEST_LOADED, this.onManifestLoaded, this);
    hls.off(Events.FRAG_LOADED, this.onFragLoaded, this);
    hls.off(Events.INIT_PTS_FOUND, this.onInitPtsFound, this);
    hls.off(Events.FRAG_PARSING_INIT_SEGMENT, this.onFragParsingInitSegment, this);
    hls.off(Events.SUBTITLE_TRACKS_CLEARED, this.onSubtitleTracksCleared, this);
  }

  addCues (trackName: string, startTime: number, endTime: number, screen: CaptionScreen) {
    // skip cues which overlap more than 50% with previously parsed time ranges
    let ranges = this.cueRanges[trackName];
    if (!ranges) {
      ranges = this.cueRanges[trackName] = [];
    }
    let merged = false;
    for (let i = ranges.length; i--;) {
      const cueRange = ranges[i];
      const overlap = intersection(cueRange[0], cueRange[1], startTime, endTime);
      if (overlap >= 0) {
        cueRange[0] = Math.min(cueRange[0], startTime);
        cueRange[1] = Math.max(cueRange[1], endTime);
        merged = true;
        if ((overlap / (endTime - startTime)) > 0.5) {
          return;
        }
      }
    }
    if (!merged) {
      ranges.push([startTime, endTime]);
    }

    if (this.config.renderTextTracksNatively) {
      this.Cues.newCue(this.captionsTracks[trackName], startTime, endTime, screen);
    } else {
      const cues = this.Cues.newCue(null, startTime, endTime, screen);
      this.hls.trigger(Events.CUES_PARSED, { type: 'captions', cues, track: trackName });
    }
  }

  // Triggered when an initial PTS is found; used for synchronisation of WebVTT.
  onInitPtsFound (event: Events.INIT_PTS_FOUND, data: InitPTSFoundData) {
    const { frag, id, initPTS } = data;
    const { unparsedVttFrags } = this;
    if (id === 'main') {
      this.initPTS[frag.cc] = initPTS;
    }

    // Due to asynchronous processing, initial PTS may arrive later than the first VTT fragments are loaded.
    // Parse any unparsed fragments upon receiving the initial PTS.
    if (unparsedVttFrags.length) {
      this.unparsedVttFrags = [];
      unparsedVttFrags.forEach(frag => {
        // TODO: This can be either FragLoadedData or FragDecryptedData
        this.onFragLoaded(Events.FRAG_LOADED, frag as FragLoadedData);
      });
    }
  }

  getExistingTrack (trackName: string): TextTrack | null {
    const { media } = this;
    if (media) {
      for (let i = 0; i < media.textTracks.length; i++) {
        const textTrack = media.textTracks[i];
        if (textTrack[trackName]) {
          return textTrack;
        }
      }
    }
    return null;
  }

  createCaptionsTrack (trackName: string) {
    if (this.config.renderTextTracksNatively) {
      this.createNativeTrack(trackName);
    } else {
      this.createNonNativeTrack(trackName);
    }
  }

  createNativeTrack (trackName: string) {
    if (this.captionsTracks[trackName]) {
      return;
    }
    const { captionsProperties, captionsTracks, media } = this;
    const { label, languageCode } = captionsProperties[trackName];
    // Enable reuse of existing text track.
    const existingTrack = this.getExistingTrack(trackName);
    if (!existingTrack) {
      const textTrack = this.createTextTrack('captions', label, languageCode);
      if (textTrack) {
        // Set a special property on the track so we know it's managed by Hls.js
        textTrack[trackName] = true;
        captionsTracks[trackName] = textTrack;
      }
    } else {
      captionsTracks[trackName] = existingTrack;
      clearCurrentCues(captionsTracks[trackName]);
      sendAddTrackEvent(captionsTracks[trackName], media as HTMLMediaElement);
    }
  }

  createNonNativeTrack (trackName: string) {
    if (this.nonNativeCaptionsTracks[trackName]) {
      return;
    }
    // Create a list of a single track for the provider to consume
    const trackProperties: TrackProperties = this.captionsProperties[trackName];
    if (!trackProperties) {
      return;
    }
    const label = trackProperties.label as string;
    const track = {
      _id: trackName,
      label,
      kind: 'captions',
      default: trackProperties.media ? !!trackProperties.media.default : false,
      closedCaptions: trackProperties.media
    };
    this.nonNativeCaptionsTracks[trackName] = track;
    this.hls.trigger(Events.NON_NATIVE_TEXT_TRACKS_FOUND, { tracks: [track] });
  }

  createTextTrack (kind: TextTrackKind, label: string, lang?: string): TextTrack | undefined {
    const media = this.media;
    if (!media) {
      return;
    }
    return media.addTextTrack(kind, label, lang);
  }

  destroy () {
    this._unregisterListeners();
  }

  onMediaAttaching (event: Events.MEDIA_ATTACHING, data: MediaAttachingData) {
    this.media = data.media;
    this._cleanTracks();
  }

  onMediaDetaching () {
    const { captionsTracks } = this;
    Object.keys(captionsTracks).forEach(trackName => {
      clearCurrentCues(captionsTracks[trackName]);
      delete captionsTracks[trackName];
    });
    this.nonNativeCaptionsTracks = {};
  }

  onManifestLoading () {
    this.lastSn = -1; // Detect discontiguity in fragment parsing
    this.prevCC = -1;
    this.vttCCs = newVTTCCs(); // Detect discontinuity in subtitle manifests
    this._cleanTracks();
    this.tracks = [];
    this.captionsTracks = {};
    this.nonNativeCaptionsTracks = {};
  }

  _cleanTracks () {
    // clear outdated subtitles
    const { media } = this;
    if (!media) {
      return;
    }
    const textTracks = media.textTracks;
    if (textTracks) {
      for (let i = 0; i < textTracks.length; i++) {
        clearCurrentCues(textTracks[i]);
      }
    }
  }

  onManifestLoaded (event: Events.MANIFEST_LOADED, data: ManifestLoadedData) {
    this.textTracks = [];
    this.unparsedVttFrags = this.unparsedVttFrags || [];
    this.initPTS = [];
    this.cueRanges = {};

    const tracks: Array<MediaPlaylist> = data.subtitles || [];
    const hasIMSC1 = tracks.some((track) => track.textCodec === IMSC1_CODEC);
    if (this.config.enableWebVTT || (hasIMSC1 && this.config.enableIMSC1)) {
      const sameTracks = this.tracks && tracks && this.tracks.length === tracks.length;
      this.tracks = tracks || [];

      if (this.config.renderTextTracksNatively) {
        const inUseTracks = this.media ? this.media.textTracks : [];

        this.tracks.forEach((track, index) => {
          let textTrack: TextTrack | undefined;
          if (index < inUseTracks.length) {
            let inUseTrack: TextTrack | null = null;
            for (let i = 0; i < inUseTracks.length; i++) {
              if (canReuseVttTextTrack(inUseTracks[i], track)) {
                inUseTrack = inUseTracks[i];
                break;
              }
            }
            // Reuse tracks with the same label, but do not reuse 608/708 tracks
            if (inUseTrack) {
              textTrack = inUseTrack;
            }
          }
          if (!textTrack) {
            textTrack = this.createTextTrack('subtitles', track.name, track.lang);
          }
          if (textTrack) {
            if (track.default) {
              textTrack.mode = this.hls.subtitleDisplay ? 'showing' : 'hidden';
            } else {
              textTrack.mode = 'disabled';
            }
            this.textTracks.push(textTrack);
          }
        });
      } else if (!sameTracks && this.tracks && this.tracks.length) {
        // Create a list of tracks for the provider to consume
        const tracksList = this.tracks.map((track) => {
          return {
            label: track.name,
            kind: track.type.toLowerCase(),
            default: track.default,
            subtitleTrack: track
          };
        });
        this.hls.trigger(Events.NON_NATIVE_TEXT_TRACKS_FOUND, { tracks: tracksList });
      }
    }

    if (this.config.enableCEA708Captions && data.captions) {
      data.captions.forEach(captionsTrack => {
        const instreamIdMatch = /(?:CC|SERVICE)([1-4])/.exec(captionsTrack.instreamId as string);
        if (!instreamIdMatch) {
          return;
        }
        const trackName = `textTrack${instreamIdMatch[1]}`;
        const trackProperties: TrackProperties = this.captionsProperties[trackName];
        if (!trackProperties) {
          return;
        }
        trackProperties.label = captionsTrack.name;
        if (captionsTrack.lang) { // optional attribute
          trackProperties.languageCode = captionsTrack.lang;
        }
        trackProperties.media = captionsTrack;
      });
    }
  }

  onFragLoaded (event: Events.FRAG_LOADED, data: FragLoadedData) {
    const { frag, payload } = data;
    const { cea608Parser, initPTS, lastSn, unparsedVttFrags } = this;
    if (frag.type === 'main') {
      const sn = frag.sn;
      // if this frag isn't contiguous, clear the parser so cues with bad start/end times aren't added to the textTrack
      if (sn !== lastSn + 1) {
        if (cea608Parser) {
          cea608Parser.reset();
        }
      }
      this.lastSn = sn as number;
    } else if (frag.type === 'subtitle') { // If fragment is subtitle type, parse as WebVTT.
      if (payload.byteLength) {
        // We need an initial synchronisation PTS. Store fragments as long as none has arrived.
        if (!Number.isFinite(initPTS[frag.cc])) {
          unparsedVttFrags.push(data);
          if (initPTS.length) {
            // finish unsuccessfully, otherwise the subtitle-stream-controller could be blocked from loading new frags.
            this.hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, { success: false, frag, error: new Error('Missing initial subtitle PTS') });
          }
          return;
        }

        const decryptData = frag.decryptdata;
        // If the subtitles are not encrypted, parse VTTs now. Otherwise, we need to wait.
        if ((decryptData == null) || (decryptData.key == null) || (decryptData.method !== 'AES-128')) {
          const trackPlaylistMedia = this.tracks[frag.level];
          const vttCCs = this.vttCCs;
          if (!vttCCs[frag.cc]) {
            vttCCs[frag.cc] = { start: frag.start, prevCC: this.prevCC, new: true };
            this.prevCC = frag.cc;
          }
          if (trackPlaylistMedia && trackPlaylistMedia.textCodec === IMSC1_CODEC) {
            this._parseIMSC1(frag, payload);
          } else {
            this._parseVTTs(frag, payload, vttCCs);
          }
        }
      } else {
        // In case there is no payload, finish unsuccessfully.
        this.hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, { success: false, frag, error: new Error('Empty subtitle payload') });
      }
    }
  }

  private _parseIMSC1 (frag: Fragment, payload: ArrayBuffer) {
    const hls = this.hls;
    parseIMSC1(payload, this.initPTS[frag.cc], (cues) => {
      this._appendCues(cues, frag.level);
      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, { success: true, frag: frag });
    }, (error) => {
      logger.log(`Failed to parse IMSC1: ${error}`);
      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, { success: false, frag: frag, error });
    });
  }

  private _parseVTTs (frag: Fragment, payload: ArrayBuffer, vttCCs: any) {
    const hls = this.hls;
    // Parse the WebVTT file contents.
    WebVTTParser.parse(payload, this.initPTS[frag.cc], vttCCs, frag.cc, (cues) => {
      this._appendCues(cues, frag.level);
      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, { success: true, frag: frag });
    }, (error) => {
      this._fallbackToIMSC1(frag, payload);
      // Something went wrong while parsing. Trigger event with success false.
      logger.log(`Failed to parse VTT cue: ${error}`);
      hls.trigger(Events.SUBTITLE_FRAG_PROCESSED, { success: false, frag: frag, error });
    });
  }

  private _fallbackToIMSC1 (frag: Fragment, payload: ArrayBuffer) {
    // If textCodec is unknown, try parsing as IMSC1. Set textCodec based on the result
    const trackPlaylistMedia = this.tracks[frag.level];
    if (!trackPlaylistMedia.textCodec) {
      parseIMSC1(payload, this.initPTS[frag.cc], () => {
        trackPlaylistMedia.textCodec = IMSC1_CODEC;
        this._parseIMSC1(frag, payload);
      }, () => {
        trackPlaylistMedia.textCodec = 'wvtt';
      });
    }
  }

  private _appendCues (cues, fragLevel) {
    const hls = this.hls;
    if (this.config.renderTextTracksNatively) {
      const textTrack = this.textTracks[fragLevel];
      cues.filter(cue => !textTrack.cues.getCueById(cue.id)).forEach(cue => {
        textTrack.addCue(cue);
      });
    } else {
      const currentTrack = this.tracks[fragLevel];
      const track = currentTrack.default ? 'default' : 'subtitles' + fragLevel;
      hls.trigger(Events.CUES_PARSED, { type: 'subtitles', cues, track });
    }
  }

  onFragDecrypted (event: Events.FRAG_DECRYPTED, data: FragDecryptedData) {
    const { frag } = data;
    if (frag.type === 'subtitle') {
      if (!Number.isFinite(this.initPTS[frag.cc])) {
        this.unparsedVttFrags.push(data as unknown as FragLoadedData);
        return;
      }
      this.onFragLoaded(Events.FRAG_LOADED, data as unknown as FragLoadedData);
    }
  }

  onSubtitleTracksCleared () {
    this.tracks = [];
    this.captionsTracks = {};
  }

  onFragParsingUserdata (event: Events.FRAG_PARSING_USERDATA, data: FragParsingUserdataData) {
    if (!this.enabled || !this.cea608Parser) {
      return;
    }

    // If the event contains captions (found in the bytes property), push all bytes into the parser immediately
    // It will create the proper timestamps based on the PTS value
    const cea608Parser = this.cea608Parser as Cea608Parser;
    for (let i = 0; i < data.samples.length; i++) {
      const ccBytes = data.samples[i].bytes;
      if (ccBytes) {
        const ccdatas = this.extractCea608Data(ccBytes);
        cea608Parser.addData(data.samples[i].pts, ccdatas[0], 1);
        cea608Parser.addData(data.samples[i].pts, ccdatas[1], 3);
      }
    }
  }

  onFragParsingInitSegment () {
    // If we receive this event, we have not received an onInitPtsFound event. This happens when the video track has no samples (but has audio)
    // In order to have captions display, which requires an initPTS, we assume one of 90000
    if (typeof this.initPTS === 'undefined') {
      this.onInitPtsFound(Events.INIT_PTS_FOUND, { id: '', frag: new Fragment(), initPTS: 90000 });
    }
  }

  extractCea608Data (byteArray: Uint8Array): number[][] {
    const count = byteArray[0] & 31;
    let position = 2;
    const actualCCBytes: number[][] = [[], []];

    for (let j = 0; j < count; j++) {
      const tmpByte = byteArray[position++];
      const ccbyte1 = 0x7F & byteArray[position++];
      const ccbyte2 = 0x7F & byteArray[position++];
      const ccValid = (4 & tmpByte) !== 0;
      const ccType = 3 & tmpByte;

      if (ccbyte1 === 0 && ccbyte2 === 0) {
        continue;
      }

      if (ccValid) {
        if (ccType === 0 || ccType === 1) {
          actualCCBytes[ccType].push(ccbyte1);
          actualCCBytes[ccType].push(ccbyte2);
        }
      }
    }
    return actualCCBytes;
  }
}

function canReuseVttTextTrack (inUseTrack, manifestTrack): boolean {
  return inUseTrack && inUseTrack.label === manifestTrack.name && !(inUseTrack.textTrack1 || inUseTrack.textTrack2);
}

function intersection (x1: number, x2: number, y1: number, y2: number): number {
  return Math.min(x2, y2) - Math.max(x1, y1);
}

function newVTTCCs (): VTTCCs {
  return {
    ccOffset: 0,
    presentationOffset: 0,
    0: {
      start: 0,
      prevCC: -1,
      new: false
    }
  };
}

export default TimelineController;
