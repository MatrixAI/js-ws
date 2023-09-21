import sysexits from './sysexits';
import ErrorWebSocket from '../ErrorWebSocket';

class ErrorUtils<T> extends ErrorWebSocket<T> {}

/**
 * This is a special error that is only used for absurd situations
 * Intended to placate typescript so that unreachable code type checks
 * If this is thrown, this means there is a bug in the code
 */
class ErrorUtilsUndefinedBehaviour<T> extends ErrorUtils<T> {
  static description = 'You should never see this error';
  exitCode = sysexits.SOFTWARE;
}

class ErrorUtilsPollTimeout<T> extends ErrorUtils<T> {
  static description = 'Poll timed out';
  exitCode = sysexits.TEMPFAIL;
}

class ErrorUtilsNodePath<T> extends ErrorUtils<T> {
  static description = 'Cannot derive default node path from unknown platform';
  exitCode = sysexits.USAGE;
}

export {
  ErrorUtils,
  ErrorUtilsUndefinedBehaviour,
  ErrorUtilsPollTimeout,
  ErrorUtilsNodePath,
};
