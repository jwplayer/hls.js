import Fragment, { FragmentPart } from './fragment';
import AttrList from '../utils/attr-list';

export default class LevelDetails {
  public PTSKnown?: boolean;
  public availabilityDelay?: number; // Manifest reload synchronization
  public averagetargetduration?: number;
  public endCC: number = 0;
  public endSN: number = 0;
  public endPart: number = -1;
  public fragments: Fragment[] = [];
  public initSegment: Fragment | null = null;
  public lastModified?: number;
  public live: boolean = true;
  public needSidxRanges: boolean = false;
  public startCC: number = 0;
  public startSN: number = 0;
  public startTimeOffset: number | null = null;
  public targetduration: number = 0;
  public tload?: number;
  public totalduration: number = 0;
  public type: string | null = null;
  public updated?: boolean; // Manifest reload synchronization
  public url: string;
  public version: number | null = null;
  public serverControl?: ServerControl;
  public partTarget?: number;
  public renditionReport?: AttrList;
  public skipped: number = 0;
  public push?: { msn: number, part: number };

  constructor (baseUrl) {
    const params = baseUrl.match(/_HLS_msn=(\d+)(.+_HLS_part=(\d+))?.+_HLS_push=1/);
    if (params && params.length === 3) {
      this.push = {
        msn: parseInt(params[1]),
        part: parseInt(params[2])
      };
    }
    this.url = baseUrl;
  }

  get hasProgramDateTime (): boolean {
    return !!this.fragments[0] && Number.isFinite(this.fragments[0].programDateTime as number);
  }

  // get partFragments (): FragmentPart[] {
  //   const parts: FragmentPart[] = [];
  //   this.fragments.forEach((fragment: Fragment) => {
  //     if (fragment.parts) {
  //       fragment.parts.forEach((part: FragmentPart) => {
  //         parts.push(part);
  //       });
  //     }
  //   });
  //   return parts;
  // }
}

export interface ServerControl {
  attrs: AttrList,
  canBlock: boolean,
  canSkipUntil: number,
  holdBack: number,
  partHoldBack: number
}
