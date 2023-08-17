/**
 * Deconstructed promise
 */
 type PromiseDeconstructed<T> = {
  p: Promise<T>;
  resolveP: (value: T | PromiseLike<T>) => void;
  rejectP: (reason?: any) => void;
};

type TLSConfig = {
  keyPrivatePem: PrivateKeyPEM;
  certChainPem: CertificatePEMChain;
};

export type {
  PromiseDeconstructed
}
