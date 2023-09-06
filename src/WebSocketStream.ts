import type { StreamCodeToReason, StreamReasonToCode } from './types';
import type WebSocketConnection from './WebSocketConnection';
import type { StreamId, StreamMessage, VarInt } from './message';
import { CreateDestroy, status } from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import { promise } from './utils';
import * as errors from './errors';
import * as events from './events';
import {
  generateStreamMessage,
  parseStreamMessage,
  StreamErrorCode,
  StreamMessageType,
  StreamShutdown,
} from './message';
import {
  ReadableStream,
  WritableStream,
  CountQueuingStrategy,
  ReadableByteStreamController,
} from 'stream/web';
import WebSocketStreamQueue from './WebSocketStreamQueue';

interface WebSocketStream extends CreateDestroy {}
/**
 * Events:
 * - {@link events.EventWebSocketStreamDestroy}
 * - {@link events.EventWebSocketStreamDestroyed}
 */
@CreateDestroy({
  eventDestroy: events.EventWebSocketStreamDestroy,
  eventDestroyed: events.EventWebSocketStreamDestroyed,
})
class WebSocketStream implements ReadableWritablePair<Uint8Array, Uint8Array> {
  public streamId: StreamId;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

  protected _readableEnded = false;
  protected _writableEnded = false;

  protected logger: Logger;
  protected connection: WebSocketConnection;
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;
  protected readableController: ReadableStreamDefaultController;
  protected writableController: WritableStreamDefaultController;

  protected readableQueue: WebSocketStreamQueue = new WebSocketStreamQueue();
  protected readableQueueBufferSize = 0;
  protected readableBufferReady = promise<void>();
  protected writableDesiredSize = 0;
  protected writableDesiredSizeProm = promise<void>();

  protected destroyProm = promise<void>();

  public static async createWebSocketStream({
    streamId,
    connection,
    bufferSize,
    reasonToCode = () => 0n,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
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
    this.logger = logger;
    this.streamId = streamId;
    this.connection = connection;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;

    this.readableQueueBufferSize = bufferSize;

    let initAckSent = false;

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: async (controller) => {
          this.readableController = controller;
        },
        pull: async (controller) => {
          // If a readable has ended, whether by the closing of the sender's WritableStream or by calling `.close`, do not bother to send back an ACK
          if (this._readableEnded) {
            return;
          }

          if (!initAckSent) {
            await this.streamSend({
              type: StreamMessageType.Ack,
              payload: bufferSize,
            });
            initAckSent = true;
            return;
          }

          // reset the promise before a read from the queue to wait until the queue has items
          if (this.readableQueue.count === 0) {
            this.readableBufferReady.resolveP();
            this.readableBufferReady = promise<void>();
          }
          await this.readableBufferReady.p;

          // data will be null in the case of stream destruction before the readable buffer is blocked
          // we're going to just enqueue an empty buffer in case it is null for some other reason, so that the next read is able to complete
          const data = this.readableQueue.dequeue();
          if (data == null) {
            controller.enqueue(new Uint8Array(0));
            return;
          }
          const readBytes = data.length;
          controller.enqueue(data);

          this.logger.debug(`${readBytes} bytes have been pushed onto stream buffer`)

          await this.streamSend({
            type: StreamMessageType.Ack,
            payload: readBytes,
          });
        },
        cancel: async (reason) => {
          this.logger.debug(`readable aborted with [${reason.message}]`);
          await this.signalReadableEnd(true, reason);
        },
      },
      {
        highWaterMark: 1,
      }
    );

    this.writable = new WritableStream(
      {
        start: (controller) => {
          this.writableController = controller;
        },
        write: async (chunk) => {
          while (chunk.length > 0) {
            // Do not bother to write or wait for ACK if the writable has ended
            if (this._writableEnded) {
              return;
            }
            this.logger.debug(
              `${chunk.length} bytes need to be written into a receiver buffer of ${this.writableDesiredSize} bytes`,
            );

            await this.writableDesiredSizeProm.p;

            // chunking
            let data: Uint8Array;
            if (chunk.length > this.writableDesiredSize) {
              this.logger.debug(
                `this chunk will be split into sizes of ${this.writableDesiredSize} bytes`,
              );
            }
            // .subarray parameters begin and end are clamped to the size of the Uint8Array
            data = chunk.subarray(0, this.writableDesiredSize);

            const bytesWritten = data.length;
            if (this.writableDesiredSize === bytesWritten) {
              this.logger.debug(`this chunk will trigger receiver to send an ACK`);
              // Reset the promise to wait for another ACK
              this.writableDesiredSizeProm = promise();
            }
            // Decrement the desired size by the amount of bytes written
            this.writableDesiredSize -= bytesWritten;
            this.logger.debug(`writableDesiredSize is now ${this.writableDesiredSize} due to write`);
            await this.streamSend({
              type: StreamMessageType.Data,
              payload: data,
            });
            chunk = chunk.subarray(bytesWritten);
          }
        },
        close: async () => {
          await this.signalWritableEnd();
        },
        abort: async (reason?: any) => {
          await this.signalWritableEnd(true, reason);
        },
      },
      {
        highWaterMark: 1,
      },
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
    await this.cancel(new errors.ErrorWebSocketStreamClose());
    // Removing stream from the connection's stream map
    // TODO: the other side currently will send back an ERROR/CLOSE frame from us sending an ERROR/CLOSE frame from this.close().
    // However, out stream gets deleted before we receive that message on the connection.
    // So the connection will infinitely create streams with the same streamId when it receives the ERROR/CLOSE frame.
    // I'm dealing with this by just filtering out ERROR/CLOSE frames in the connection's onMessage handler, but there might be a better way to do this.
    this.connection.streamMap.delete(this.streamId);
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  protected async streamSend(message: StreamMessage): Promise<void> {
    const array = generateStreamMessage(message);
    await this.connection.streamSend(this.streamId, array);
  }

  /**
   * Put a message frame into a stream.
   * This will not will not error out, but will rather close the ReadableStream assuming any further reads are expected to fail.
   * @param message - The message to put into the stream.
   * @internal
   */
  public async streamRecv(message: Uint8Array) {
    if (message.length === 0) {
      this.logger.debug(`received empty message, closing stream`);
      await this.signalReadableEnd(
        true,
        new errors.ErrorWebSocketStreamReadableParse('empty message', {
          cause: new RangeError(),
        }),
      );
      return;
    }

    let parsedMessage: StreamMessage;
    try {
      parsedMessage = parseStreamMessage(message);
    } catch (err) {
      await this.signalReadableEnd(
        true,
        new errors.ErrorWebSocketStreamReadableParse(err.message, {
          cause: err,
        }),
      );
      return;
    }

    if (parsedMessage.type === StreamMessageType.Ack) {
      this.writableDesiredSize += parsedMessage.payload;
      this.writableDesiredSizeProm.resolveP();
      this.logger.debug(`writableDesiredSize is now ${this.writableDesiredSize} due to ACK`);
    } else if (parsedMessage.type === StreamMessageType.Data) {
      if (this._readableEnded) {
        return;
      }
      if (
        parsedMessage.payload.length > (this.readableQueueBufferSize - this.readableQueue.length)
      ) {
        await this.signalReadableEnd(
          true,
          new errors.ErrorWebSocketStreamReadableBufferOverload(),
        );
        return;
      }
      this.readableQueue.queue(parsedMessage.payload);
      this.readableBufferReady.resolveP();
    } else if (parsedMessage.type === StreamMessageType.Error) {
      const { shutdown, code } = parsedMessage.payload;
      let reason: any;
      switch (code) {
        case BigInt(StreamErrorCode.ErrorReadableStreamParse):
          reason = new errors.ErrorWebSocketStreamReadableParse(
            'receiver was unable to parse a sent message',
          );
          break;
        case BigInt(StreamErrorCode.ErrorReadableStreamBufferOverflow):
          reason = new errors.ErrorWebSocketStreamReadableBufferOverload(
            'receiver was unable to accept a sent message',
          );
          break;
        default:
          reason = await this.codeToReason('recv', code);
      }
      if (shutdown === StreamShutdown.Read) {
        await this.signalReadableEnd(true, reason);
      } else if (shutdown === StreamShutdown.Write) {
        await this.signalWritableEnd(true, reason);
      }
    } else if (parsedMessage.type === StreamMessageType.Close) {
      const shutdown = parsedMessage.payload;
      if (shutdown === StreamShutdown.Read) {
        if (this._readableEnded) {
          return;
        }
        await this.signalReadableEnd(false);
        this.readableController.close();
      } else if (shutdown === StreamShutdown.Write) {
        if (this._writableEnded) {
          return;
        }
        await this.signalWritableEnd(false);
      }
    }
  }

  /**
   * Forces the active stream to end early
   */
  public async cancel(reason?: any) {
    const isError =
      reason != null && !(reason instanceof errors.ErrorWebSocketStreamClose);
    reason = reason ?? new errors.ErrorWebSocketStreamCancel();
    // Close the streams with the given error,
    if (!this._readableEnded) {
      this.readableController.error(reason);
      await this.signalReadableEnd(isError, reason);
    }
    if (!this._writableEnded) {
      this.writableController.error(reason);
      await this.signalWritableEnd(isError, reason);
    }
  }

  /**
   * Signals the end of the ReadableStream. to be used with the extended class
   * to track the streams state.
   */
  protected async signalReadableEnd(isError: boolean = false, reason?: any) {
    if (isError) {
      this.logger.debug(`ending readable with error ${reason.message}`);
    } else {
      this.logger.debug(`ending readable`);
    }
    if (this._readableEnded) return;
    // Indicate that receiving side is closed
    this._readableEnded = true;
    // Resolve readable promise in case blocking
    this.readableBufferReady.resolveP();
    // clear the readable queue
    this.readableQueue.clear();
    // Shutdown the write side of the other stream
    if (isError) {
      let code: VarInt;
      if (reason instanceof errors.ErrorWebSocketStreamReadableParse) {
        code = BigInt(StreamErrorCode.ErrorReadableStreamParse) as VarInt;
      } else if (
        reason instanceof errors.ErrorWebSocketStreamReadableBufferOverload
      ) {
        code = BigInt(
          StreamErrorCode.ErrorReadableStreamBufferOverflow,
        ) as VarInt;
      } else {
        code = (await this.reasonToCode('send', reason)) as VarInt;
      }
      await this.streamSend({
        type: StreamMessageType.Error,
        payload: {
          shutdown: StreamShutdown.Read,
          code,
        },
      });
      this.readableController.error(reason);
    } else {
      await this.streamSend({
        type: StreamMessageType.Close,
        payload: StreamShutdown.Write,
      });
    }
    if (this._readableEnded && this._writableEnded) {
      this.destroyProm.resolveP();
      if (this[status] !== 'destroying') await this.destroy();
    }
    this.logger.debug(`readable ended`);
  }

  /**
   * Signals the end of the WritableStream. to be used with the extended class
   * to track the streams state.
   */
  protected async signalWritableEnd(isError: boolean = false, reason?: any) {
    if (isError) {
      this.logger.debug(`ending writable with error ${reason.message}`);
    } else {
      this.logger.debug(`ending writable`);
    }
    if (this._writableEnded) return;
    // Indicate that sending side is closed
    this._writableEnded = true;
    // Resolve backpressure blocking promise in case unresolved
    this.writableDesiredSizeProm.resolveP();
    // Shutdown the read side of the other stream
    if (isError) {
      let code: VarInt;
      if (reason instanceof errors.ErrorWebSocketStreamReadableParse) {
        code = BigInt(StreamErrorCode.ErrorReadableStreamParse) as VarInt;
      } else if (
        reason instanceof errors.ErrorWebSocketStreamReadableBufferOverload
      ) {
        code = BigInt(
          StreamErrorCode.ErrorReadableStreamBufferOverflow,
        ) as VarInt;
      } else {
        code = (await this.reasonToCode('send', reason)) as VarInt;
      }
      await this.streamSend({
        type: StreamMessageType.Error,
        payload: {
          shutdown: StreamShutdown.Read,
          code,
        },
      });
      this.writableController.error(reason);
    } else {
      await this.streamSend({
        type: StreamMessageType.Close,
        payload: StreamShutdown.Read,
      });
    }
    if (this._readableEnded && this._writableEnded) {
      this.destroyProm.resolveP();
      if (this[status] !== 'destroying') await this.destroy();
    }
    this.logger.debug(`writable ended`);
  }
}

export default WebSocketStream;
