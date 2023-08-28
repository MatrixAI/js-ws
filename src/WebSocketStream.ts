import { CreateDestroy } from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import {} from 'stream/web';
import type { StreamId } from './types';
import { promise, StreamCode } from './utils';
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
  protected _readableEndedProm = promise();
  protected _writableEnded = false;
  protected _writableEndedProm = promise();

  protected logger: Logger;
  protected connection: WebSocketConnection;
  protected readableController: ReadableStreamController<Uint8Array>;
  protected writableController: WritableStreamDefaultController;

  protected writableDesiredSize = 0;
  protected writableDesiredSizeProm = promise<void>();

  public static async createWebSocketStream({
    streamId,
    connection,
    bufferSize,
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
    bufferSize: number;
    logger?: Logger;
  }): Promise<WebSocketStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      streamId,
      connection,
      bufferSize,
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
    logger,
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
    bufferSize: number;
    logger: Logger;
  }) {
    super();
    this.streamId = streamId;
    this.connection = connection;
    this.logger = logger;

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: async (controller) => {
          this.readableController = controller;
        },
        pull: async (controller) => {
          if (controller.desiredSize == null) {
            controller.error(new errors.ErrorWebSocketUndefinedBehaviour());
          }
          if (controller.desiredSize! > 0) {
            await this.streamSend(StreamCode.ACK, controller.desiredSize!).catch((e) => controller.error(e));
          }
        },
        cancel: async (reason) => {},
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
      try {
        if (this.writableDesiredSize === data.length) {
          this.logger.debug(`this chunk will trigger receiver to send an ACK`);
          // Resolve and reset the promise to wait for another ACK
          this.writableDesiredSizeProm.resolveP();
          this.writableDesiredSizeProm = promise();
        }
        const bytesWritten = this.writableDesiredSize;
        await this.streamSend(StreamCode.DATA, data).catch((e) => controller.error(e));
        this.writableDesiredSize =- data.length;
        if (isChunkable) {
          await writableWrite(chunk.subarray(bytesWritten), controller);
        }
      }
      catch {
        this.writableDesiredSizeProm.resolveP();
        // TODO: Handle error
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
          this.signalWritableEnd(reason);
        },
      },
      {
        highWaterMark: 1
      }
    );
  }

  public async destroy() {
    this.logger.info(`Destroy ${this.constructor.name}`);
    // Force close any open streams
    this.cancel();
    // Removing stream from the connection's stream map
    this.connection.streamMap.delete(this.streamId);
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  public async streamSend(code: StreamCode): Promise<void>;
  public async streamSend(code: StreamCode.ACK, payloadSize: number): Promise<void>;
  public async streamSend(code: StreamCode.DATA, data: Uint8Array): Promise<void>;
  public async streamSend(code: StreamCode, data_?: Uint8Array | number): Promise<void> {
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
    try {
      await this.connection.streamSend(this.streamId, array);
    }
    catch (e) {
      this.signalWritableEnd(e);
      throw e;
    }
  }

  public async streamRecv(message: Uint8Array) {
    const code = message[0] as StreamCode;
    const data = message.subarray(1);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (code === StreamCode.DATA) {
      if (this.readableController.desiredSize == null) {
        this.readableController.error(new errors.ErrorWebSocketUndefinedBehaviour());
        return;
      }
      if (data.length > this.readableController.desiredSize) {
        this.readableController.error(new errors.ErrorWebSocketStream());
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
      this.readableController.error(new errors.ErrorWebSocketStream());
    }
    else if (code === StreamCode.CLOSE) {
      // close the stream
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
      this.signalReadableEnd(reason);
    }
    if (!this._writableEnded) {
      this.writableController.error(reason);
      this.signalWritableEnd(reason);
    }
  }

  /**
   * Signals the end of the ReadableStream. to be used with the extended class
   * to track the streams state.
   */
  protected signalReadableEnd(reason?: any) {
    if (this._readableEnded) return;
    this._readableEnded = true;
    if (reason == null) this._readableEndedProm.resolveP();
    else this._readableEndedProm.rejectP(reason);
  }

  /**
   * Signals the end of the WritableStream. to be used with the extended class
   * to track the streams state.
   */
  protected signalWritableEnd(reason?: any) {
    if (this._writableEnded) return;
    this._writableEnded = true;
    if (reason == null) this._writableEndedProm.resolveP();
    else this._writableEndedProm.rejectP(reason);
  }
}

export default WebSocketStream;
