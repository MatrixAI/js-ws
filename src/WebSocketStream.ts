import type {
  ConnectionMetadata,
  StreamCodeToReason,
  StreamReasonToCode,
} from './types';
import type WebSocketConnection from './WebSocketConnection';
import type { StreamId, StreamMessage, VarInt } from './message';
import type {
  ReadableWritablePair,
  WritableStreamDefaultController,
  ReadableStreamDefaultController,
} from 'stream/web';
import {
  ReadableStream,
  WritableStream,
  CountQueuingStrategy,
} from 'stream/web';
import {
  CreateDestroy,
  ready,
  destroyed,
  initLock
} from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import { generateStreamId } from './message';
import * as utils from './utils';
import * as errors from './errors';
import * as events from './events';
import {
  generateStreamMessage,
  parseStreamMessage,
  StreamErrorCode,
  StreamMessageType,
  StreamShutdown,
} from './message';
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
  public static async createWebSocketStream({
    initiated,
    streamId,
    connection,
    bufferSize,
    reasonToCode = () => 0n,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    initiated: 'local' | 'peer';
    streamId: StreamId;
    connection: WebSocketConnection;
    bufferSize: number;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }): Promise<WebSocketStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      initiated,
      streamId,
      connection,
      bufferSize,
      reasonToCode,
      codeToReason,
      logger,
    });
    stream.addEventListener(
      events.EventWebSocketStreamError.name,
      stream.handleEventWebSocketStreamError,
    );
    stream.addEventListener(
      events.EventWebSocketStreamCloseRead.name,
      stream.handleEventWebSocketStreamCloseRead,
      { once: true }
    );
    stream.addEventListener(
      events.EventWebSocketStreamCloseWrite.name,
      stream.handleEventWebSocketStreamCloseWrite,
      { once: true }
    );
    logger.info(`Created ${this.name}`);
    return stream;
  }

  public readonly initiated: 'local' | 'peer';

  public readonly streamId: StreamId;
  public readonly encodedStreamId: Uint8Array;
  /**
   * Errors:
   * - {@link errors.ErrorWebSocketStreamClose} - This will happen if the stream is closed with {@link WebSocketStream.destroy} or if the {@link WebSocketConnection} was closed.
   * - {@link errors.ErrorWebSocketStreamCancel} - This will happen if the stream is closed with {@link WebSocketStream.cancel}
   * - {@link errors.ErrorWebSocketStreamUnknown} - Unknown error
   * - {@link errors.ErrorWebSocketStreamReadableBufferOverload} - This will happen when the readable buffer is overloaded
   * - {@link errors.ErrorWebSocketStreamReadableParse} - This will happen when the ReadableStream cannot parse an incoming message
   */
  public readonly readable: ReadableStream<Uint8Array>;
  /**
   * Errors:
   * - {@link errors.ErrorWebSocketStreamClose} - This will happen if the stream is closed with {@link WebSocketStream.destroy} or if the {@link WebSocketConnection} was closed.
   * - {@link errors.ErrorWebSocketStreamCancel} - This will happen if the stream is closed with {@link WebSocketStream.cancel}
   * - {@link errors.ErrorWebSocketStreamUnknown} - Unknown error
   * - {@link errors.ErrorWebSocketStreamReadableBufferOverload} - This will happen when the receiving ReadableStream's buffer is overloaded
   * - {@link errors.ErrorWebSocketStreamReadableParse} - This will happen when the receiving ReadableStream cannot parse a sent message
   */
  public readonly writable: WritableStream<Uint8Array>;

  protected logger: Logger;
  protected connection: WebSocketConnection;
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;
  protected readableController: ReadableStreamDefaultController;
  protected writableController: WritableStreamDefaultController;

  protected _readClosed = false;
  protected _writeClosed = false;

  protected readableQueue: WebSocketStreamQueue = new WebSocketStreamQueue();
  protected readableQueueBufferSize = 0;
  protected readableBufferReady = utils.promise<void>();
  protected writableDesiredSize = 0;
  protected writableDesiredSizeProm = utils.promise<void>();
  protected initAckSent = false;

  public readonly closedP: Promise<void>;
  protected resolveClosedP: () => void;

  /**
   * We expect WebSocket stream error in 2 ways.
   * WebSocket stream closure of the stream codes.
   * On read side
   * On write side
   * We are able to use exception classes to distinguish things
   * Because it's always about the error itself!A
   * Note that you must distinguish between actual internal errors, and errors on the stream itself
   */
  protected handleEventWebSocketStreamError = async (evt: events.EventWebSocketStreamError) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
  };

  protected handleEventWebSocketStreamCloseRead = async () => {
    this._readClosed = true;
    if (this._readClosed && this._writeClosed) {
      this.resolveClosedP();
      if (!this[destroyed]) {
        // If we are destroying, we still end up calling this
        // This is to enable, that when a failed cancellation to continue to destroy
        // By disabling force, we don't end up running cancel again
        // But that way it does infact successfully destroy
        // Failing to destroy is also a caller error, there's no domain error handling (because this runs once)
        // So we let it bubble up
        await this.destroy({ force: false });
      }
    }
  };

  protected handleEventWebSocketStreamCloseWrite = async () => {
    this._writeClosed = true;
    if (this._readClosed && this._writeClosed) {
      this.resolveClosedP();
      if (!this[destroyed]) {
        // If we are destroying, we still end up calling this
        // This is to enable, that when a failed cancellation to continue to destroy
        // By disabling force, we don't end up running cancel again
        // But that way it does infact successfully destroy
        await this.destroy({ force: false });
      }
    }
  };

  /**
   * @internal
   */
  constructor({
    initiated,
    streamId,
    connection,
    bufferSize,
    reasonToCode,
    codeToReason,
    logger,
  }: {
    initiated: 'local' | 'peer';
    streamId: StreamId;
    connection: WebSocketConnection;
    bufferSize: number;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
    logger: Logger;
  }) {
    this.logger = logger;
    this.initiated = initiated;
    this.streamId = streamId;
    this.encodedStreamId = generateStreamId(streamId);
    this.connection = connection;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    // This will be used to know when both readable and writable is closed
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;

    this.readableQueueBufferSize = bufferSize;

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: this.readableStart.bind(this),
        pull: this.readablePull.bind(this),
        cancel: this.readableCancel.bind(this),
      },
      new CountQueuingStrategy({
        highWaterMark: 1,
      }),
    );

    this.writable = new WritableStream(
      {
        start: this.writableStart.bind(this),
        write: this.writableWrite.bind(this),
        close: this.writableClose.bind(this),
        abort: this.writableAbort.bind(this),
      },
      {
        highWaterMark: 1,
      },
    );
  }

  /**
   * Returns connection data for the connection this stream is on.
   */
  @ready(new errors.ErrorWebSocketStreamDestroyed())
  public get meta(): ConnectionMetadata {
    return this.connection.meta();
  }

  /**
   * Returns true if the writable has closed.
   */
  public get writeClosed(): boolean {
    return this.writeClosed;
  }

  /**
   * Returns true if the readable has closed.
   */
  public get readClosed(): boolean {
    return this._readClosed;
  }

  public get closed() {
    return this._readClosed && this._writeClosed;
  }

  /**
   * This method can be arrived top-down or bottom-up:
   *
   * 1. Top-down control flow - means explicit destruction from WebSocketConnection
   * 2. Bottom-up control flow - means stream events from users of this stream
   *
   * If force is true then this will cancel readable and abort writable.
   * If force is false then it will just wait for readable and writable to be closed.
   *
   * Unlike WebSocketConnection, this defaults to true for force.
   *
   * @throws {errors.ErrorWebSocketStreamInternal}
   */
  public async destroy({
    force = true,
    reason
  }: {
    force?: boolean;
    reason?: any;
  } = {}) {
    this.logger.info(`Destroy ${this.constructor.name}`);
    if (force && !(this._readClosed && this._writeClosed)) {
      // If force is true, we are going to cancel the 2 streams
      // This means cancelling the readable stream and aborting the writable stream
      // Whether this fails or succeeds, it will trigger the close handler
      // Which means we recurse back into `this.destroy`.
      // If it failed, it recurses into destroy and will succeed (because the force will be false)
      // If it succeeded, it recurses into destroy into a noop.
      this.cancel(reason);
    }
    await this.closedP;
    this.removeEventListener(
      events.EventWebSocketStreamError.name,
      this.handleEventWebSocketStreamError
    );
    this.removeEventListener(
      events.EventWebSocketStreamCloseRead.name,
      this.handleEventWebSocketStreamCloseRead,
    );
    this.removeEventListener(
      events.EventWebSocketStreamCloseWrite.name,
      this.handleEventWebSocketStreamCloseWrite
    );
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Will trigger the destruction of the `WebSocketStream` if the readable or writable haven't closed, yet they will be forced
   * closed with `reason` as the error.
   * If streams have already closed then this will do nothing.
   * This is synchronous by design but cancelling will happen asynchronously in the background.
   *
   * This ends up calling the cancel and abort methods.
   * Those methods are needed because the readable and writable might be locked with
   * a reader and writer respectively. So we have to cancel and abort from the "inside" of
   * the stream.
   * It's essential that this is synchronous, as that ensures only one thing is running at a time.
   * Note that if cancellation fails...
   *
   * Calling this will lead an asynchronous destruction of this `WebSocketStream` instance.
   * This could throw actually. But cancellation is likely to have occurred.
   *
   * @throws {errors.ErrorWebSocketStreamInternal}
   */
  public async cancel(reason?: any) {
    try {
      this.readableCancel(reason);
    } catch (e) {
      // If cancelling readable failed here, it would have dispatched the domain error and close for read
      // So we need to also dispatch the close for write here, because failing to cancel is a domain error
      this.dispatchEvent(new events.EventWebSocketStreamCloseWrite());
      throw e;
    }
    // If this failed, it will be a domain error, but readable cancel would have succeeded
    this.writableAbort(reason);
  }

  protected readableStart(controller: ReadableStreamDefaultController): void {
    this.readableController = controller;
  }

  protected writableStart(controller: WritableStreamDefaultController): void {
    this.writableController = controller;
  }

  protected async readablePull(controller: ReadableStreamDefaultController): Promise<void> {
    // If a readable has ended, whether by the closing of the sender's WritableStream or by calling `.close`, do not bother to send back an ACK
    if (this._readClosed) {
      return;
    }

    if (!this.initAckSent) {
      this.streamSend({
        type: StreamMessageType.Ack,
        payload: this.readableQueueBufferSize,
      });
      this.initAckSent = true;
      return;
    }

    // Reset the promise before a read from the queue to wait until the queue has items
    if (this.readableQueue.count === 0) {
      this.readableBufferReady.resolveP();
      this.readableBufferReady = utils.promise<void>();
    }
    await this.readableBufferReady.p;

    // Data will be null in the case of stream destruction before the readable buffer is blocked
    // we're going to just enqueue an empty buffer in case it is null for some other reason, so that the next read is able to complete
    const data = this.readableQueue.dequeue();
    if (data == null) {
      controller.enqueue(new Uint8Array(0));
      return;
    }
    const readBytes = data.length;
    controller.enqueue(data);

    this.logger.debug(
      `${readBytes} bytes have been pushed onto stream buffer`,
    );

    this.streamSend({
      type: StreamMessageType.Ack,
      payload: readBytes,
    });
  }

  protected async writableWrite(chunk: Uint8Array): Promise<void> {

  }

  /**
   * This is mutually exclusive with write.
   * It will be serialised!
   */
  protected writableClose(): void {
    // Graceful close on the write without any code
    this.dispatchEvent(
      new events.EventWebSocketStreamCloseWrite({
        detail: { type: 'local' }
      })
    );
    this.streamSend({
      type: StreamMessageType.Close,
      payload: StreamShutdown.Read
    });
  }

  /**
   * This is factored out and callable by both `readable.cancel` and `this.cancel`.
   * ReadableStream ensures that this method is idempotent
   *
   * @throws {errors.ErrorWebSocketStreamInternal}
   */
  protected readableCancel(reason?: any): void {
    // Ignore if already closed
    // This is only needed if this function is called from `this.cancel`.
    // Because the web stream already ensures `cancel` is idempotent.
    if (this._readClosed) return;
    const code = this.reasonToCode('read', reason) as VarInt;
    const e = new errors.ErrorWebSocketStreamLocalRead(
      'Closing readable stream locally',
      {
        data: { code },
        cause: reason
      }
    );
    // This is idempotent and won't error even if it is already stopped
    this.readableController.error(reason);
    // This rejects the readableP if it exists
    // The pull method may be blocked by `await readableP`
    // When rejected, it will throw up the exception
    // However because the stream is cancelled, then
    // the exception has no effect, and any reads of this stream
    // will simply return `{ value: undefined, done: true }`
    this.readableBufferReady.resolveP();
    this.dispatchEvent(
      new events.EventWebSocketStreamError({
        detail: e
      })
    );
    this.dispatchEvent(
      new events.EventWebSocketStreamCloseRead({
        detail: {
          type: 'local',
          code: code
        }
      })
    );
    this.streamSend({
      type: StreamMessageType.Error,
      payload: {
        shutdown: StreamShutdown.Write,
        code
      }
    });
    return;
  }

  /**
   * This is factored out and callable by both `writable.abort` and `this.cancel`.
   *
   * @throws {errors.ErrorWebSocketStreamInternal}
   */
  protected writableAbort(reason?: any): void {
    // Ignore if already closed
    // This is only needed if this function is called from `this.cancel`.
    // Because the web stream already ensures `cancel` is idempotent.
    if (this._writeClosed) return;
    const code = this.reasonToCode('write', reason) as VarInt;
    const e = new errors.ErrorWebSocketStreamLocalWrite(
      'Closing writable stream locally',
      {
        data: { code },
        cause: reason
      }
    );
    this.writableController.error(e);
    // This will reject the writable call
    // But at the same time, it means the writable stream transitions to errored state
    // But the whole writable stream is going to be closed anyway
    this.writableDesiredSizeProm.resolveP();
    this.dispatchEvent(
      new events.EventWebSocketStreamError({
        detail: e
      })
    );
    this.dispatchEvent(
      new events.EventWebSocketStreamCloseWrite({
        detail: {
          type: 'local',
          code
        }
      })
    );
    // TODO: change to dispatch event
    this.streamSend({
      type: StreamMessageType.Error,
      payload: {
        shutdown: StreamShutdown.Read,
        code
      }
    });
    return;
  }


  protected streamSend(message: StreamMessage) {
    const array = generateStreamMessage(message, false);
    array.unshift(this.encodedStreamId);
    const evt = new events.EventWebSocketStreamSend();
    evt.msg = array;
    this.dispatchEvent(evt);
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
      this.readableCancel(
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
      await this.readableCancel(
        new errors.ErrorWebSocketStreamReadableParse(err.message, {
          cause: err,
        }),
      );
      return;
    }

    if (parsedMessage.type === StreamMessageType.Ack) {
      this.writableDesiredSize += parsedMessage.payload;
      this.writableDesiredSizeProm.resolveP();
      this.logger.debug(
        `writableDesiredSize is now ${this.writableDesiredSize} due to ACK`,
      );
    } else if (parsedMessage.type === StreamMessageType.Data) {
      if (this._readClosed) {
        return;
      }
      if (
        parsedMessage.payload.length >
        this.readableQueueBufferSize - this.readableQueue.length
      ) {
        this.readableCancel(
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
        case StreamErrorCode.Unknown:
          reason = new errors.ErrorWebSocketStreamUnknown(
            'receiver encountered an unknown error',
          );
          break;
        case StreamErrorCode.ErrorReadableStreamParse:
          reason = new errors.ErrorWebSocketStreamReadableParse(
            'receiver was unable to parse a sent message',
          );
          break;
        case StreamErrorCode.ErrorReadableStreamBufferOverflow:
          reason = new errors.ErrorWebSocketStreamReadableBufferOverload(
            'receiver was unable to accept a sent message',
          );
          break;
        default:
          reason = await this.codeToReason('read', code);
      }
      if (shutdown === StreamShutdown.Read) {
        if (this._readClosed) return;
        const code = this.reasonToCode('read', reason) as VarInt;
        const e = new errors.ErrorWebSocketStreamLocalRead(
          'Closing readable stream due to Error message from peer',
          {
            data: { code },
            cause: reason
          }
        );
        this.readableController.error(reason);
        this.readableBufferReady.resolveP();
        this.dispatchEvent(
          new events.EventWebSocketStreamError({
            detail: e
          })
        );
        this.dispatchEvent(
          new events.EventWebSocketStreamCloseRead({
            detail: {
              type: 'local',
              code: code
            }
          })
        );
        this.streamSend({
          type: StreamMessageType.Error,
          payload: {
            shutdown: StreamShutdown.Write,
            code
          }
        });
      } else if (shutdown === StreamShutdown.Write) {
        if (this._writeClosed) return;
        const code = this.reasonToCode('write', reason) as VarInt;
        const e = new errors.ErrorWebSocketStreamLocalWrite(
          'Closing writable stream due to Error message from peer',
          {
            data: { code },
            cause: reason
          }
        );
        this.writableController.error(e);
        this.writableDesiredSizeProm.resolveP();
        this.dispatchEvent(
          new events.EventWebSocketStreamError({
            detail: e
          })
        );
        this.dispatchEvent(
          new events.EventWebSocketStreamCloseWrite({
            detail: {
              type: 'local',
              code
            }
          })
        );
        // TODO: change to dispatch event
        this.streamSend({
          type: StreamMessageType.Error,
          payload: {
            shutdown: StreamShutdown.Read,
            code
          }
        });
      }
    } else if (parsedMessage.type === StreamMessageType.Close) {
      const shutdown = parsedMessage.payload;
      if (shutdown === StreamShutdown.Read) {
        if (this._readClosed) return;
        this.readableController.close();
        this.readableBufferReady.resolveP();
        this.dispatchEvent(
          new events.EventWebSocketStreamCloseRead({
            detail: {
              type: 'peer',
            }
          })
        );
        this.streamSend({
          type: StreamMessageType.Close,
          payload: StreamShutdown.Write,
        });
      } else if (shutdown === StreamShutdown.Write) {
        if (this._writeClosed) return;
        // Realistically this should never happen due to Readable stream not being able to be closed
        const code = StreamErrorCode.Unknown;
        const reason = new errors.ErrorWebSocketStreamUnknown();
        const e = new errors.ErrorWebSocketStreamLocalWrite(
          'Closing writable stream due to Close message from peer',
          {
            data: { code },
            cause: reason
          }
        );
        this.writableController.error(e);
        this.writableDesiredSizeProm.resolveP();
        this.dispatchEvent(
          new events.EventWebSocketStreamError({
            detail: e
          })
        );
        this.dispatchEvent(
          new events.EventWebSocketStreamCloseWrite({
            detail: {
              type: 'peer',
              code
            }
          })
        );
        this.streamSend({
          type: StreamMessageType.Error,
          payload: {
            shutdown: StreamShutdown.Read,
            code
          }
        });
      }
    }
  }
}

export default WebSocketStream;
