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
  StartStop,
  ready,
  running,
  status,
} from '@matrixai/async-init/dist/StartStop';
import Logger from '@matrixai/logger';
import { generateStreamId } from './message';
import * as utils from './utils';
import * as errors from './errors';
import * as events from './events';
import {
  generateStreamMessage,
  parseStreamMessage,
  StreamMessageType,
  StreamShutdown,
} from './message';
import WebSocketStreamQueue from './WebSocketStreamQueue';

interface WebSocketStream extends StartStop {}
/**
 * Events:
 * - {@link events.EventWebSocketStreamStart}
 * - {@link events.EventWebSocketStreamStarted}
 * - {@link events.EventWebSocketStreamStop}
 * - {@link events.EventWebSocketStreamStopped}
 * - {@link events.EventWebSocketStreamError}
 * - {@link events.EventWebSocketStreamCloseRead}
 * - {@link events.EventWebSocketStreamCloseWrite}
 * - {@link events.EventWebSocketStreamSend}
 */
@StartStop({
  eventStart: events.EventWebSocketStreamStart,
  eventStarted: events.EventWebSocketStreamStarted,
  eventStop: events.EventWebSocketStreamStop,
  eventStopped: events.EventWebSocketStreamStopped,
})
class WebSocketStream implements ReadableWritablePair<Uint8Array, Uint8Array> {
  public async start(): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    this.addEventListener(
      events.EventWebSocketStreamError.name,
      this.handleEventWebSocketStreamError,
    );
    this.addEventListener(
      events.EventWebSocketStreamCloseRead.name,
      this.handleEventWebSocketStreamCloseRead,
      { once: true },
    );
    this.addEventListener(
      events.EventWebSocketStreamCloseWrite.name,
      this.handleEventWebSocketStreamCloseWrite,
      { once: true },
    );
    this.logger.info(`Started ${this.constructor.name}`);
    this.streamSend({
      type: StreamMessageType.Ack,
      payload: this.readableQueueBufferSize,
    });
  }

  public readonly initiated: 'local' | 'peer';

  public readonly streamId: StreamId;
  public readonly encodedStreamId: Uint8Array;
  /**
   * Errors:
   * - {@link errors.ErrorWebSocketStreamClose} - This will happen if the stream is closed with {@link WebSocketStream.stop} or if the {@link WebSocketConnection} was closed.
   * - {@link errors.ErrorWebSocketStreamCancel} - This will happen if the stream is closed with {@link WebSocketStream.cancel}
   * - {@link errors.ErrorWebSocketStreamUnknown} - Unknown error
   * - {@link errors.ErrorWebSocketStreamReadableBufferOverload} - This will happen when the readable buffer is overloaded
   * - {@link errors.ErrorWebSocketStreamReadableParse} - This will happen when the ReadableStream cannot parse an incoming message
   * - any errors from `.cancel(reason)`
   */
  public readonly readable: ReadableStream<Uint8Array>;
  /**
   * Errors:
   * - {@link errors.ErrorWebSocketStreamClose} - This will happen if the stream is closed with {@link WebSocketStream.stop} or if the {@link WebSocketConnection} was closed.
   * - {@link errors.ErrorWebSocketStreamCancel} - This will happen if the stream is closed with {@link WebSocketStream.cancel}
   * - {@link errors.ErrorWebSocketStreamUnknown} - Unknown error
   * - {@link errors.ErrorWebSocketStreamReadableBufferOverload} - This will happen when the receiving ReadableStream's buffer is overloaded
   * - {@link errors.ErrorWebSocketStreamReadableParse} - This will happen when the receiving ReadableStream cannot parse a sent message
   * - any errors from `.cancel(reason)` or `.abort(reason)`
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
  protected writableDesiredSize = 0;
  protected resolveReadableP?: () => void;
  protected rejectReadableP?: (reason?: any) => void;
  protected resolveWritableP?: () => void;
  protected rejectWritableP?: (reason?: any) => void;

  /**
   * Resolved when the stream has been completely closed (both readable and writable sides).
   */
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
  protected handleEventWebSocketStreamError = async (
    evt: events.EventWebSocketStreamError,
  ) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
    if (error instanceof errors.ErrorWebSocketStreamInternal) {
      throw error;
    }
    if (
      error instanceof errors.ErrorWebSocketStreamLocalRead ||
      error instanceof errors.ErrorWebSocketStreamPeerRead
    ) {
      this.dispatchEvent(
        new events.EventWebSocketStreamCloseRead({
          detail: error,
        }),
      );
    } else if (
      error instanceof errors.ErrorWebSocketStreamLocalWrite ||
      error instanceof errors.ErrorWebSocketStreamPeerWrite
    ) {
      this.dispatchEvent(
        new events.EventWebSocketStreamCloseWrite({
          detail: error,
        }),
      );
    }
  };

  protected handleEventWebSocketStreamCloseRead = async () => {
    this._readClosed = true;
    if (this._readClosed && this._writeClosed) {
      this.resolveClosedP();
      if (this[running] && this[status] !== 'stopping') {
        await this.stop({ force: false });
      }
    }
  };

  protected handleEventWebSocketStreamCloseWrite = async () => {
    this._writeClosed = true;
    if (this._readClosed && this._writeClosed) {
      this.resolveClosedP();
      if (this[running] && this[status] !== 'stopping') {
        // If we are destroying, we still end up calling this
        // This is to enable, that when a failed cancellation to continue to destroy
        // By disabling force, we don't end up running cancel again
        // But that way it does infact successfully destroy
        await this.stop({ force: false });
      }
    }
  };

  constructor({
    initiated,
    streamId,
    connection,
    bufferSize,
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    logger,
  }: {
    initiated: 'local' | 'peer';
    streamId: StreamId;
    connection: WebSocketConnection;
    bufferSize: number;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }) {
    this.logger = logger ?? new Logger(`${this.constructor.name}`);
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
    return this._writeClosed;
  }

  /**
   * Returns true if the readable has closed.
   */
  public get readClosed(): boolean {
    return this._readClosed;
  }

  /**
   * Whether the stream has been completely closed (both readable and writable sides).
   */
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
   */
  public async stop({
    force = true,
    reason,
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
      this.handleEventWebSocketStreamError,
    );
    this.removeEventListener(
      events.EventWebSocketStreamCloseRead.name,
      this.handleEventWebSocketStreamCloseRead,
    );
    this.removeEventListener(
      events.EventWebSocketStreamCloseWrite.name,
      this.handleEventWebSocketStreamCloseWrite,
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
   */
  public cancel(reason?: any) {
    this.readableCancel(reason);
    this.writableAbort(reason);
  }

  protected readableStart(controller: ReadableStreamDefaultController): void {
    this.readableController = controller;
  }

  protected writableStart(controller: WritableStreamDefaultController): void {
    this.writableController = controller;
  }

  protected async readablePull(
    controller: ReadableStreamDefaultController,
  ): Promise<void> {
    // If a readable has ended, whether by the closing of the sender's WritableStream or by calling `.close`, do not bother to send back an ACK
    if (this._readClosed) {
      return;
    }

    const {
      p: readableP,
      resolveP: resolveReadableP,
      rejectP: rejectReadableP,
    } = utils.promise<void>();

    this.resolveReadableP = resolveReadableP;
    this.rejectReadableP = rejectReadableP;

    // Resolve the promise immediately if there are messages
    // If not, wait for there to be to messages
    if (this.readableQueue.count > 0) {
      resolveReadableP();
    }
    await readableP;

    // Data will be null in the case of stream destruction before the readable buffer is blocked
    // we're going to just enqueue an empty buffer in case it is null for some other reason, so that the next read is able to complete
    const data = this.readableQueue.dequeue();
    if (data == null) {
      controller.enqueue([]);
      return;
    }
    const readBytes = data.length;
    controller.enqueue(data);

    this.logger.debug(`${readBytes} bytes have been pushed onto stream buffer`);

    this.streamSend({
      type: StreamMessageType.Ack,
      payload: readBytes,
    });
  }

  protected async writableWrite(chunk: Uint8Array): Promise<void> {
    while (chunk.length > 0) {
      // Do not bother to write or wait for ACK if the writable has ended
      if (this._writeClosed) {
        return;
      }
      this.logger.debug(
        `${chunk.length} bytes need to be written into a receiver buffer of ${this.writableDesiredSize} bytes`,
      );

      const {
        p: writableP,
        resolveP: resolveWritableP,
        rejectP: rejectWritableP,
      } = utils.promise<void>();

      this.resolveWritableP = resolveWritableP;
      this.rejectWritableP = rejectWritableP;

      // Resolve the promise immediately if there is available space to be written
      // If not, wait for the writableDesiredSize to be updated by the peer
      if (this.writableDesiredSize > 0) {
        resolveWritableP();
      }
      await writableP;

      // Chunking
      // .subarray parameters begin and end are clamped to the size of the Uint8Array
      const data = chunk.subarray(0, this.writableDesiredSize);
      if (chunk.length > this.writableDesiredSize) {
        this.logger.debug(
          `this chunk will be split into sizes of ${this.writableDesiredSize} bytes`,
        );
      }

      const bytesWritten = data.length;
      // Decrement the desired size by the amount of bytes written
      this.writableDesiredSize -= bytesWritten;
      this.logger.debug(
        `writableDesiredSize is now ${this.writableDesiredSize} due to write`,
      );
      this.streamSend({
        type: StreamMessageType.Data,
        payload: data,
      });
      chunk = chunk.subarray(bytesWritten);
    }
  }

  /**
   * This is mutually exclusive with write.
   * It will be serialised!
   */
  protected writableClose(): void {
    // Graceful close on the write without any code
    this.dispatchEvent(new events.EventWebSocketStreamCloseWrite());
    this.streamSend({
      type: StreamMessageType.Close,
      payload: StreamShutdown.Read,
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
    const code = this.reasonToCode('read', reason);
    const e = new errors.ErrorWebSocketStreamLocalRead(
      'Closing readable stream locally',
      {
        data: { code },
        cause: reason,
      },
    );
    // This is idempotent and won't error even if it is already stopped
    this.readableController.error(reason);
    // This rejects the readableP if it exists
    // The pull method may be blocked by `await readableP`
    // When rejected, it will throw up the exception
    // However because the stream is cancelled, then
    // the exception has no effect, and any reads of this stream
    // will simply return `{ value: undefined, done: true }`
    this.rejectReadableP?.(reason);
    this.dispatchEvent(
      new events.EventWebSocketStreamError({
        detail: e,
      }),
    );
    this.streamSend({
      type: StreamMessageType.Error,
      payload: {
        shutdown: StreamShutdown.Write,
        code: BigInt(code) as VarInt,
      },
    });
    // No need to flush the queue into the readable here,
    // cancel flushes the internal readable buffer anyways
    this.readableQueue.clear();
    return;
  }

  /**
   * This is factored out and callable by both `writable.abort` and `this.cancel`.
   */
  protected writableAbort(reason?: any): void {
    // Ignore if already closed
    // This is only needed if this function is called from `this.cancel`.
    // Because the web stream already ensures `cancel` is idempotent.
    if (this._writeClosed) return;
    const code = this.reasonToCode('write', reason);
    const e = new errors.ErrorWebSocketStreamLocalWrite(
      'Closing writable stream locally',
      {
        data: { code },
        cause: reason,
      },
    );
    this.writableController.error(reason);
    // This will reject the writable call
    // But at the same time, it means the writable stream transitions to errored state
    // But the whole writable stream is going to be closed anyway
    this.rejectWritableP?.(reason);
    this.dispatchEvent(
      new events.EventWebSocketStreamError({
        detail: e,
      }),
    );
    this.streamSend({
      type: StreamMessageType.Error,
      payload: {
        shutdown: StreamShutdown.Read,
        code: BigInt(code) as VarInt,
      },
    });
    return;
  }

  protected streamSend(message: StreamMessage) {
    const array = [this.encodedStreamId];
    array.push(...generateStreamMessage(message, false));
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
    let parsedMessage: StreamMessage;
    try {
      parsedMessage = parseStreamMessage(message);
    } catch (err) {
      const e = new errors.ErrorWebSocketStreamInternal(
        'Peer sent a malformed stream message',
      );
      this.dispatchEvent(
        new events.EventWebSocketStreamError({
          detail: e,
        }),
      );
      return;
    }

    if (parsedMessage.type === StreamMessageType.Ack) {
      this.writableDesiredSize += parsedMessage.payload;
      this.resolveWritableP?.();
      this.logger.debug(
        `writableDesiredSize is now ${this.writableDesiredSize} due to ACK`,
      );
    } else if (parsedMessage.type === StreamMessageType.Data) {
      if (this._readClosed) {
        const e = new errors.ErrorWebSocketStreamInternal(
          'Peer has overflowed the buffer of the ReadableStream',
        );
        this.dispatchEvent(
          new events.EventWebSocketStreamError({
            detail: e,
          }),
        );
        return;
      }
      if (
        parsedMessage.payload.length >
        this.readableQueueBufferSize - this.readableQueue.length
      ) {
        return;
      }
      this.readableQueue.queue(parsedMessage.payload);
      this.resolveReadableP?.();
    } else if (parsedMessage.type === StreamMessageType.Error) {
      const { shutdown, code } = parsedMessage.payload;
      const reason = this.codeToReason('read', Number(code));
      if (shutdown === StreamShutdown.Read) {
        if (this._readClosed) return;
        const e = new errors.ErrorWebSocketStreamLocalRead(
          'Closing readable stream due to Error message from peer',
          {
            data: { code: Number(code) },
            cause: reason,
          },
        );
        this.readableController.error(reason);
        this.rejectReadableP?.(reason);
        this.dispatchEvent(
          new events.EventWebSocketStreamError({
            detail: e,
          }),
        );
        this.streamSend({
          type: StreamMessageType.Error,
          payload: {
            shutdown: StreamShutdown.Write,
            code,
          },
        });
      } else if (shutdown === StreamShutdown.Write) {
        if (this._writeClosed) return;
        const e = new errors.ErrorWebSocketStreamLocalWrite(
          'Closing writable stream due to Error message from peer',
          {
            data: { code: Number(code) },
            cause: reason,
          },
        );
        this.writableController.error(reason);
        this.rejectWritableP?.(reason);
        this.dispatchEvent(
          new events.EventWebSocketStreamError({
            detail: e,
          }),
        );
        // TODO: change to dispatch event
        this.streamSend({
          type: StreamMessageType.Error,
          payload: {
            shutdown: StreamShutdown.Read,
            code,
          },
        });
      }
    } else if (parsedMessage.type === StreamMessageType.Close) {
      const shutdown = parsedMessage.payload;
      if (shutdown === StreamShutdown.Read) {
        if (this._readClosed) return;
        // Flush the readable queue,
        // in the case where this.readableController.close is called, we're expecting the buffer to not be flushed
        for (const data of this.readableQueue) {
          this.readableController.enqueue(data);
        }
        this.readableController.close();
        this.readableQueue.clear();
        this.resolveReadableP?.();
        this.dispatchEvent(new events.EventWebSocketStreamCloseRead());
        this.streamSend({
          type: StreamMessageType.Close,
          payload: StreamShutdown.Write,
        });
      } else if (shutdown === StreamShutdown.Write) {
        if (this._writeClosed) return;
        // Realistically this should never happen due to Readable stream not being able to be closed
        const code = 0;
        const reason = new errors.ErrorWebSocketStreamInternal();
        const e = new errors.ErrorWebSocketStreamLocalWrite(
          'Closing writable stream due to Close message from peer',
          {
            data: { code },
            cause: reason,
          },
        );
        this.writableController.error(reason);
        this.rejectWritableP?.(reason);
        this.dispatchEvent(
          new events.EventWebSocketStreamError({
            detail: e,
          }),
        );
        this.streamSend({
          type: StreamMessageType.Error,
          payload: {
            shutdown: StreamShutdown.Read,
            code: BigInt(code) as VarInt,
          },
        });
      }
    }
  }
}

export default WebSocketStream;
