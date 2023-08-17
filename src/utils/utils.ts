import type {
  PromiseDeconstructed,
} from '../types';
import * as utilsErrors from './errors';


function never(): never {
  throw new utilsErrors.ErrorUtilsUndefinedBehaviour();
}

/**
 * Deconstructed promise
 */
function promise<T = void>(): PromiseDeconstructed<T> {
  let resolveP, rejectP;
  const p = new Promise<T>((resolve, reject) => {
    resolveP = resolve;
    rejectP = reject;
  });
  return {
    p,
    resolveP,
    rejectP,
  };
}

export {
  never,
  promise
};
