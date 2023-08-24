import { CreateDestroy } from "@matrixai/async-init/dist/CreateDestroy";
import Logger from "@matrixai/logger";
import {  } from "stream/web";
import { StreamId } from "./types";
import { promise, StreamCode } from "./utils";
import WebSocketConnection from "./WebSocketConnection";
import * as errors from './errors';

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
  protected readableController:
  | ReadableStreamController<Uint8Array>
  | undefined;
  protected writableController: WritableStreamDefaultController | undefined;


  public static async createWebSocketStream({
    streamId,
    connection,
    logger = new Logger(`${this.name} ${streamId}`)
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
    logger: Logger;
  }): Promise<WebSocketStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      streamId,
      connection,
      logger
    });
    connection.streamMap.set(streamId, stream);
    logger.info(`Created ${this.name}`);
    return stream;
  }

  constructor({
    streamId,
    connection,
    logger
  }: {
    streamId: StreamId;
    connection: WebSocketConnection;
    logger: Logger;
  }) {
    super();
    this.streamId = streamId;
    this.connection = connection;
    this.logger = logger;

    this.readable = new ReadableStream(
      {
        start: async (controller) => {
          try {
            await this.streamSend(StreamCode.ACK)
          }
          catch (err) {
            controller.error(err);
          }

        },
        pull: async (controller) => {

        },
        cancel: async (reason) => {

        }
      },
      new CountQueuingStrategy({
        // Allow 1 buffered message, so we can know when data is desired, and we can know when to un-pause.
        highWaterMark: 1,
      })
    );

    this.writable = new WritableStream(
      {
        start: async (controller) => {
        },
        write: async (chunk: Uint8Array, controller) => {
          try {
            await this.streamSend(StreamCode.DATA, chunk)
          }
          catch (err) {
            controller.error(err);
          }
        },
        close: async () => {
          await this.streamSend(StreamCode.CLOSE);
          this.signalWritableEnd();
        },
        abort: async (reason?: any) => {
          this.signalWritableEnd(reason);
        }
      },
      {
        highWaterMark: 1,
      }
    );
  }

  public async destroy() {
    this.logger.info(`Destroy ${this.constructor.name}`);
    // force close any open streams
    this.cancel();
    // Removing stream from the connection's stream map
    this.connection.streamMap.delete(this.streamId);
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  public async streamSend(code: StreamCode)
  public async streamSend(code: StreamCode.ACK, payloadSize: number)
  public async streamSend(code: StreamCode.DATA, data: Uint8Array)
  public async streamSend(
    code: StreamCode,
    data_?: Uint8Array | number,
  ) {
    let data: Uint8Array | undefined;
    if (code === StreamCode.ACK && typeof data_ === 'number') {
      data = new Uint8Array([data_]);
    }
    else {
      data = data_ as Uint8Array | undefined;
    }
    let arrayLength = 1 + (data?.length ?? 0);
    const array = new Uint8Array(arrayLength);
    array.set([code], 0);
    if (data != null) {
      array.set(data, 1);
    }
    await this.connection.streamSend(this.streamId, array);
  }

  public async streamRecv(message: Uint8Array) {
    this.logger.debug(message);
  }

  /**
   * Forces the active stream to end early
   */
  public cancel(reason?: any): void {
    // Default error
    const err = reason ?? new errors.ErrorWebSocketStreamCancel();
    // Close the streams with the given error,
    if (!this._readableEnded) {
      this.readableController?.error(err);
      this.signalReadableEnd(err);
    }
    if (!this._writableEnded) {
      this.writableController?.error(err);
      this.signalWritableEnd(err);
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
