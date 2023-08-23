import { CreateDestroy } from "@matrixai/async-init/dist/CreateDestroy";
import Logger from "@matrixai/logger";
import {  } from "stream/web";
import { StreamId } from "./types";
import WebSocketConnection from "./WebSocketConnection";

interface WebSocketStream extends CreateDestroy {}
@CreateDestroy()
class WebSocketStream
  extends EventTarget
  implements ReadableWritablePair<Uint8Array, Uint8Array>
{
  public streamId: StreamId;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

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
        start: (controller) => {

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
        start: (controller) => {

        },
        write: async (chunk: Uint8Array, controller) => {

        },
        close: async () => {

        },
        abort: async (reason?: any) => {

        }
      },
      {
        highWaterMark: 0,
      }
    );
  }

  public async destroy() {
    this.logger.info(`Destroy ${this.constructor.name}`);
    this.connection.streamMap.delete(this.streamId);
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }
}

export default WebSocketStream;
