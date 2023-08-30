import { CreateDestroy, status } from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import type { StreamCodeToReason, StreamId, StreamReasonToCode } from './types';
import { fromVarInt, never, promise, StreamType, StreamShutdown, toVarInt } from './utils';
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
    reasonToCode = () => 0n,
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
            await this.streamSend(StreamType.ACK, controller.desiredSize!);
          }
        },
        cancel: async (reason) => {
          this.logger.debug(`readable aborted with [${reason.message}]`);
          await this.signalReadableEnd(true, reason);
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
        await this.streamSend(StreamType.DATA, data);
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
          await this.signalWritableEnd();
        },
        abort: async (reason?: any) => {
          await this.signalWritableEnd(true, reason);
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
    this.cancel();
    // Removing stream from the connection's stream map
    this.connection.streamMap.delete(this.streamId);
    this.dispatchEvent(new events.WebSocketStreamDestroyEvent());
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Send an ACK frame with a payloadSize.
   * @param code - ACK
   * @param payloadSize - The number of bytes that the receiver can accept.
   */
  protected async streamSend(type: StreamType.ACK, payloadSize: number): Promise<void>;
   /**
    * Send a DATA frame with a payload on the stream.
    * @param code - DATA
    * @param data - The payload to send.
    */
  protected async streamSend(type: StreamType.DATA, data: Uint8Array): Promise<void>;
   /**
    * Send an ERROR frame with a payload on the stream.
    * @param code - CLOSE
    * @param shutdown - Signifies whether the ReadableStream or the WritableStream has been shutdown.
    */
  protected async streamSend(type: StreamType.ERROR, shutdown: StreamShutdown, code: bigint): Promise<void>;
   /**
    * Send a CLOSE frame with a payload on the stream.
    * @param code - CLOSE
    * @param shutdown - Signifies whether the ReadableStream or the WritableStream has been shutdown.
    */
  protected async streamSend(type: StreamType.CLOSE, shutdown: StreamShutdown): Promise<void>;
  protected async streamSend(type: StreamType, data_?: Uint8Array | number, code?: bigint): Promise<void> {
    let data: Uint8Array | undefined;
    if (type === StreamType.ACK && typeof data_ === 'number') {
      data = new Uint8Array(4);
      const dv = new DataView(data.buffer);
      dv.setUint32(0, data_, false);
    } else if (type === StreamType.DATA) {
      data = data_ as Uint8Array;
    }
    else if (type === StreamType.ERROR) {
      const errorCode = fromVarInt(code!);
      data = new Uint8Array(1 + errorCode.length);
      const dv = new DataView(data.buffer);
      dv.setUint8(0, data_ as StreamShutdown);
      data.set(errorCode, 1);
    }
    else if (type === StreamType.CLOSE) {
      data = new Uint8Array([data_ as StreamShutdown]);
    }
    else {
    never();
    }
    const arrayLength = 1 + (data?.length ?? 0);
    const array = new Uint8Array(arrayLength);
    array.set([type], 0);
    if (data != null) {
      array.set(data, 1);
    }
    await this.connection.streamSend(this.streamId, array);
  }

  public async streamRecv(message: Uint8Array) {
    const type = message[0] as StreamType;
    const data = message.subarray(1);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (type === StreamType.ACK) {
      const bufferSize = dv.getUint32(0, false);
      this.writableDesiredSize = bufferSize;
      this.writableDesiredSizeProm.resolveP();
      this.logger.debug(`received ACK, writerDesiredSize is now reset to ${bufferSize} bytes`);
    }
    else if (type === StreamType.DATA) {
      if (this.readableController.desiredSize != null && data.length > this.readableController.desiredSize) {
        await this.signalReadableEnd(true, new errors.ErrorWebSocketStreamReaderBufferOverload());
        return;
      }
      this.readableController.enqueue(data);
    }
    else if (type === StreamType.ERROR || type === StreamType.CLOSE) {
      const shutdown = dv.getUint8(0) as StreamShutdown;
      let isError = false;
      let reason: any;
      if (type === StreamType.ERROR) {
        isError = true;
        const errorCode = toVarInt(data.subarray(1)).data;
        reason = await this.codeToReason('recv', errorCode);
      }
      if (shutdown === StreamShutdown.Read) {
        await this.signalReadableEnd(isError, reason);
      }
      else if (shutdown === StreamShutdown.Write) {
        await this.signalWritableEnd(isError, reason);
      }
      else {
        never();
      }
    }
    else {
      never();
    }
  }

  /**
   * Forces the active stream to end early
   */
  public cancel(reason?: any): void {
    console.log(reason)
    const isError = reason != null;
    // Close the streams with the given error,
    if (!this._readableEnded) {
      this.readableController.error(reason);
      void this.signalReadableEnd(isError, reason);
    }
    if (!this._writableEnded) {
      this.writableController.error(reason);
      void this.signalWritableEnd(isError, reason);
    }
  }

  /**
   * Signals the end of the ReadableStream. to be used with the extended class
   * to track the streams state.
   */
  protected async signalReadableEnd(isError: boolean = false, reason?: any) {
    if (isError) this.logger.debug(`ending readable with error ${reason.message}`);
    else this.logger.debug(`ending readable`);
    if (this._readableEnded) return;
    // indicate that receiving side is closed
    this._readableEnded = true;
    // shutdown the write side of the other stream
    if (isError) {
      const code = await this.reasonToCode('send', reason);
      this.streamSend(StreamType.ERROR, StreamShutdown.Write, code);
    }
    else {
      this.streamSend(StreamType.CLOSE, StreamShutdown.Write);
    }
    this.readableController.error(reason);
    if (this._readableEnded && this._writableEnded) {
      this.destroyProm.resolveP();
      if (this[status] !== 'destroying') void this.destroy();
    }
    this.logger.debug(`readable ended`);
  }

  /**
   * Signals the end of the WritableStream. to be used with the extended class
   * to track the streams state.
   */
  protected async signalWritableEnd(
    isError: boolean = false,
    reason?: any,
  ) {
    if (isError) this.logger.debug(`ending writable with error ${reason.message}`);
    else this.logger.debug(`ending writable`);
    if (this._writableEnded) return;
    // indicate that sending side is closed
    this._writableEnded = true;
    // shutdown the read side of the other stream
    if (isError) {
      const code = await this.reasonToCode('send', reason);
      this.streamSend(StreamType.ERROR, StreamShutdown.Read, code);

    }
    else {
      this.streamSend(StreamType.CLOSE, StreamShutdown.Read);
    }
    this.writableController.error(reason);
    if (this._readableEnded && this._writableEnded) {
      this.destroyProm.resolveP();
      if (this[status] !== 'destroying') void this.destroy();
    }
    this.logger.debug(`writable ended`);
  }
}

export default WebSocketStream;
