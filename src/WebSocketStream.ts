import { CreateDestroy, status } from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import type { StreamCodeToReason, StreamId, StreamReasonToCode } from './types';
import { never, promise, StreamCode } from './utils';
import type WebSocketConnection from './WebSocketConnection';
import * as errors from './errors';
import * as events from './events';

interface WebSocketStream extends CreateDestroy {}
@CreateDestroy()
class WebSocketStream
  extends EventTarget
  implements ReadableWritablePair<Uint8Array, Uint8Array>
{
  public streamId: StreamId;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

  protected _readableEnded = false;
  protected _writableEnded = false;

  protected logger: Logger;
  protected connection: WebSocketConnection;
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;
  protected readableController: ReadableStreamController<Uint8Array>;
  protected writableController: WritableStreamDefaultController;

  protected writableDesiredSize = 0;
  protected writableDesiredSizeProm = promise<void>();

  protected destroyProm = promise<void>();

  public static async createWebSocketStream({
    streamId,
    connection,
    bufferSize,
    reasonToCode = () => 0,
    codeToReason = (type, code) => new Error(`${type.toString()} ${code.toString()}`),
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
    bufferSize: number;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }): Promise<WebSocketStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      streamId,
      connection,
      bufferSize,
      reasonToCode,
      codeToReason,
      logger,
    });
    connection.streamMap.set(streamId, stream);
    logger.info(`Created ${this.name}`);
    return stream;
  }

  constructor({
    streamId,
    connection,
    bufferSize,
    reasonToCode,
    codeToReason,
    logger,
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
    bufferSize: number;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.streamId = streamId;
    this.connection = connection;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: async (controller) => {
          this.readableController = controller;
          this.logger.debug('started');
        },
        pull: async (controller) => {
          if (controller.desiredSize != null && controller.desiredSize > 0) {
            await this.streamSend(StreamCode.ACK, controller.desiredSize!);
          }
        },
        cancel: async (reason) => {
          this.logger.debug(`readable aborted with [${reason.message}]`);
          this.signalReadableEnd(true, reason);
        },
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: bufferSize,
      })
    );

    const writableWrite = async (chunk: Uint8Array, controller: WritableStreamDefaultController) => {
      await this.writableDesiredSizeProm.p;
      this.logger.debug(`${chunk.length} bytes need to be written into a receiver buffer of ${this.writableDesiredSize} bytes`);
      let data: Uint8Array;
      const isChunkable = chunk.length > this.writableDesiredSize;
      if (isChunkable) {
        this.logger.debug(`this chunk will be split into sizes of ${this.writableDesiredSize} bytes`);
        data = chunk.subarray(0, this.writableDesiredSize);
      }
      else {
        data = chunk;
      }
      const oldProm = this.writableDesiredSizeProm;
      try {
        if (this.writableDesiredSize === data.length) {
          this.logger.debug(`this chunk will trigger receiver to send an ACK`);
          // Reset the promise to wait for another ACK
          this.writableDesiredSizeProm = promise();
        }
        const bytesWritten = this.writableDesiredSize;
        await this.streamSend(StreamCode.DATA, data);
        // Decrement the desired size and resolved the old promise as to not block application exit
        this.writableDesiredSize =- data.length;
        oldProm.resolveP();
        if (isChunkable) {
          await writableWrite(chunk.subarray(bytesWritten), controller);
        }
      }
      catch {
        this.writableDesiredSizeProm = oldProm;
      }
    }

    this.writable = new WritableStream(
      {
        start: (controller) => {
          this.writableController = controller;
        },
        write: writableWrite,
        close: async () => {
          this.signalWritableEnd();
        },
        abort: async (reason?: any) => {
          this.signalWritableEnd(true, reason);
        },
      },
      {
        highWaterMark: 1
      }
    );
  }

  public get readableEnded(): boolean {
    return this._readableEnded;
  }

  public get writableEnded(): boolean {
    return this.writableEnded;
  }

  public get destroyedP() {
    return this.destroyProm.p;
  }

  public async destroy() {
    this.logger.info(`Destroy ${this.constructor.name}`);
    // Force close any open streams
    this.writableDesiredSizeProm.resolveP();
    this.cancel(new errors.ErrorWebSocketStreamClose());
    // Removing stream from the connection's stream map
    this.connection.streamMap.delete(this.streamId);
    this.dispatchEvent(new events.WebSocketStreamDestroyEvent());
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Send a code with no payload on the stream.
   * @param code - The stream code to send.
   */
  protected async streamSend(code: StreamCode): Promise<void>;
  /**
   * Send an ACK frame with a payloadSize.
   * @param code - ACK
   * @param payloadSize
   */
  protected async streamSend(code: StreamCode.ACK, payloadSize: number): Promise<void>;
  /**
   * Send a DATA frame with a payload on the stream.
   * @param code - DATA
   * @param data - The payload to send.
   */
  protected async streamSend(code: StreamCode.DATA, data: Uint8Array): Promise<void>;
  protected async streamSend(code: StreamCode, data_?: Uint8Array | number): Promise<void> {
    let data: Uint8Array | undefined;
    if (code === StreamCode.ACK && typeof data_ === 'number') {
      data = new Uint8Array(4);
      const dv = new DataView(data.buffer);
      dv.setUint32(0, data_, false);
    } else {
      data = data_ as Uint8Array | undefined;
    }
    const arrayLength = 1 + (data?.length ?? 0);
    const array = new Uint8Array(arrayLength);
    array.set([code], 0);
    if (data != null) {
      array.set(data, 1);
    }
    await this.connection.streamSend(this.streamId, array);
  }

  public async streamRecv(message: Uint8Array) {
    if (message.length === 0) {
      this.logger.debug('received empty message, closing stream');
      this.signalReadableEnd(true, new errors.ErrorWebSocketStream());
      return;
    }
    const code = message[0] as StreamCode;
    const data = message.subarray(1);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (code === StreamCode.DATA) {
      if (this.readableController.desiredSize != null && data.length > this.readableController.desiredSize) {
        if (!this._readableEnded) {
          this.signalReadableEnd(true, new errors.ErrorWebSocketStream());
        }
        return;
      }
      this.readableController.enqueue(data);
    }
    else if (code === StreamCode.ACK) {
      const bufferSize = dv.getUint32(0, false);
      this.writableDesiredSize = bufferSize;
      this.writableDesiredSizeProm.resolveP();
      this.logger.debug(`received ACK, writerDesiredSize is now reset to ${bufferSize} bytes`);
    }
    else if (code === StreamCode.ERROR) {
      this.cancel(new errors.ErrorWebSocketStream());
    }
    else if (code === StreamCode.CLOSE) {
      this.cancel();
    }
  }

  /**
   * Forces the active stream to end early
   */
  public cancel(reason?: any): void {
    reason = reason ?? new errors.ErrorWebSocketStreamCancel();
    // Close the streams with the given error,
    if (!this._readableEnded) {
      this.readableController.error(reason);
      this.signalReadableEnd(true, reason);
    }
    if (!this._writableEnded) {
      this.writableController.error(reason);
      this.signalWritableEnd(true, reason);
    }
  }

  /**
   * Signals the end of the ReadableStream. to be used with the extended class
   * to track the streams state.
   */
  protected signalReadableEnd(isError: boolean = false, reason?: any) {
    if (isError) this.logger.debug(`readable ended with error ${reason.message}`);
    if (this._readableEnded) return;
    this.logger.debug(`end readable`);
    // indicate that receiving side is closed
    this._readableEnded = true;
    if (isError) {
      this.readableController.error(reason);
    }
    if (this._readableEnded && this._writableEnded) {
      this.destroyProm.resolveP();
      void this.streamSend(StreamCode.CLOSE);
      if (this[status] !== 'destroying') void this.destroy();
    }
    this.logger.debug(`readable ended`);
  }

  /**
   * Signals the end of the WritableStream. to be used with the extended class
   * to track the streams state.
   */
  protected signalWritableEnd(
    isError: boolean = false,
    reason?: any,
  ) {
    if (isError) this.logger.debug(`writable ended with error ${reason.message}`);
    if (this._writableEnded) return;
    // indicate that sending side is closed
    this._writableEnded = true;
    if (isError) {
      this.readableController.error(reason);
    }
    if (this._readableEnded && this._writableEnded) {
      this.destroyProm.resolveP();
      void this.streamSend(StreamCode.CLOSE);
      if (this[status] !== 'destroying') void this.destroy();
    }
    this.logger.debug(`writable ended`);
  }

  /**
   * This will process any errors from a `streamSend` or `streamRecv`, extract the code and covert to a reason.
   * Will return null if the error was not an expected stream ending error.
   */
  protected async processSendStreamError(
    e: Error,
    type: 'recv' | 'send',
  ): Promise<any | null> {
    let match =
      e.message.match(/StreamStopped\((.+)\)/) ??
      e.message.match(/StreamReset\((.+)\)/);
    if (match != null) {
      const code = parseInt(match[1]);
      return await this.codeToReason(type, code);
    }
    match = e.message.match(/InvalidStreamState\((.+)\)/);
    if (match != null) {
      // `InvalidStreamState()` returns the stream ID and not any actual error code
      return never('Should never reach an [InvalidState(StreamId)] error');
    }
    return null;
  }
}

export default WebSocketStream;
