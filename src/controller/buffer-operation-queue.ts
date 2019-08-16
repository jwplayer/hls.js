import { logger } from '../utils/logger';
import { BufferOperation, SourceBuffers, SourceBufferName } from '../types/buffer';

export default class BufferOperationQueue {
  private buffers: SourceBuffers;
  public queues = {
    audio: [] as Array<BufferOperation>,
    video: [] as Array<BufferOperation>
  };

  constructor (sourceBufferReference: SourceBuffers) {
    this.buffers = sourceBufferReference;
  }

  // TODO: Handle media errors, (!this.media || this.media.error)
  public append (operation: BufferOperation, type: SourceBufferName) {
    const { buffers, queues } = this;
    const queue = queues[type];
    queue.push(operation);
    if (queue.length === 1 && buffers[type]) {
      this.executeNext(type);
    }
  }

  public appendBlocker (type: SourceBufferName) : Promise<{}> {
    let execute;
    const promise: Promise<{}> = new Promise((resolve, reject) => { execute = resolve; });
    const operation = {
      execute,
      onComplete: () => {},
      onError: () => {}
    };

    this.append(operation, type);
    return promise;
  }

  public executeNext (type: SourceBufferName) {
    const { buffers, queues } = this;
    const sb = buffers[type];
    console.assert(!sb || !sb.updating, `${type} sourceBuffer must exist, and must not be updating`);

    const queue = queues[type];
    if (queue.length) {
      const operation: BufferOperation = queue[0];
      try {
        // Operations are expected to result in an 'updateend' event being fired. If not, the queue will lock. Operations
        // which do not end with this event must call _onSBUpdateEnd manually
        operation.execute();
      } catch (e) {
        logger.warn(`[buffer-operation-queue]: Unhandled exception executing the current operation`);
        operation.onError(e);

        // Only shift the current operation off, otherwise the updateend handler will do this for us
        if (!sb || !sb.updating) {
          queue.shift();
        }
      }
    }
  }

  public shiftAndExecuteNext (type: SourceBufferName) {
    // console.log(`>>> ${type} queue length: ${this.queues[type].length}`);
    this.queues[type].shift();
    this.executeNext(type);
  }
}
