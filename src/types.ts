/**
 * Deconstructed promise
 */
 type PromiseDeconstructed<T> = {
  p: Promise<T>;
  resolveP: (value: T | PromiseLike<T>) => void;
  rejectP: (reason?: any) => void;
};

type TLSConfig = {
  keyPrivatePem: string;
  certChainPem: string;
};

export type {
  PromiseDeconstructed,
  TLSConfig
}
