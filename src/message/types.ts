import type { Opaque } from '../types';
import type { StreamMessageType, StreamShutdown } from './utils';

interface Parsed<T> {
  data: T;
  remainder: Uint8Array;
}

/**
 * VarInt is a 62 bit unsigned integer
 */
type VarInt = Opaque<'VarInt', bigint>;

/**
 * StreamId is a VarInt
 */
type StreamId = VarInt;

type ConnectionMessage = {
  streamId: StreamId;
} & StreamMessage;

type StreamMessage =
  | StreamMessageAck
  | StreamMessageData
  | StreamMessageClose
  | StreamMessageError;

type StreamMessageBase<StreamMessageType, PayloadType> = {
  type: StreamMessageType;
  payload: PayloadType;
};

type StreamMessageAck = StreamMessageBase<StreamMessageType.Ack, number>;

type StreamMessageData = StreamMessageBase<StreamMessageType.Data, Uint8Array>;

type StreamMessageClose = StreamMessageBase<
  StreamMessageType.Close,
  StreamShutdown
>;

type StreamMessageError = StreamMessageBase<
  StreamMessageType.Error,
  {
    shutdown: StreamShutdown;
    code: VarInt;
  }
>;

export type {
  Parsed,
  VarInt,
  StreamId,
  ConnectionMessage,
  StreamMessage,
  StreamMessageBase,
  StreamMessageAck,
  StreamMessageData,
  StreamMessageClose,
  StreamMessageError,
};
