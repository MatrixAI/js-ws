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
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
    logger: Logger;
  }): Promise<WebSocketStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      streamId,
      connection,
      logger,
    });
    connection.streamMap.set(streamId, stream);
    logger.info(`Created ${this.name}`);
    return stream;
  }

  constructor({
    streamId,
    connection,
    logger,
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
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
          try {
            await this.streamSend(StreamCode.ACK);
          } catch (err) {
            controller.error(err);
          }
        },
        pull: async (controller) => {

        },
        cancel: async (reason) => {},
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: 0xFFFFFFFF,
      })
    );

    const writableWrite = async (chunk: Uint8Array, controller: WritableStreamDefaultController) => {
      await this.writableDesiredSizeProm.p;
      let data: Uint8Array;
      const isChunkable = chunk.length > this.writableDesiredSize;
      if (isChunkable) {
        data = chunk.subarray(0, this.writableDesiredSize);
      }
      else {
        data = chunk;
      }
      const newWritableDesiredSize = this.writableDesiredSize - data.length;
      const oldProm = this.writableDesiredSizeProm;
      try {
        if (this.writableDesiredSize <= 0) {
          this.writableDesiredSizeProm = promise();
        }
        await this.streamSend(StreamCode.DATA, chunk);
        this.writableDesiredSize = newWritableDesiredSize;
        if (isChunkable) {
          await writableWrite(chunk.subarray(this.writableDesiredSize), controller);
        }
      }
      catch {
        this.writableDesiredSizeProm = oldProm;
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
          await this.streamSend(StreamCode.CLOSE);
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

  public async streamSend(code: StreamCode);
  public async streamSend(code: StreamCode.ACK, payloadSize: number);
  public async streamSend(code: StreamCode.DATA, data: Uint8Array);
  public async streamSend(code: StreamCode, data_?: Uint8Array | number) {
    let data: Uint8Array | undefined;
    if (code === StreamCode.ACK && typeof data_ === 'number') {
      data = new Uint8Array([data_]);
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
    const code = message[0] as StreamCode;
    const data = message.subarray(1);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (code === StreamCode.DATA) {
      const data = message.subarray(1);
      this.readableController.enqueue(data);
      this.readableController.desiredSize;
    }
    else if (code === StreamCode.ACK) {
      console.log(data);
      const bufferSize = dv.getUint32(0, false);
      console.log(bufferSize);
      this.writableDesiredSize = bufferSize;
      this.writableDesiredSizeProm.resolveP();

    }
    else if (code === StreamCode.ERROR) {
      this.readableController?.error(new errors.ErrorWebSocketStream());
    }
    else if (code === StreamCode.CLOSE) {
      // close the stream
    }

    this.readableController?.enqueue(data);
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
