import type { StreamId } from '@/types';
import { fc, testProp } from '@fast-check/jest';
import * as utils from '@/utils';

const MAX_62_BIT_UINT = 2n ** 62n - 1n;

describe('utils', () => {
  testProp(
    'from/to StreamId',
    [fc.bigUint().filter((n) => n <= MAX_62_BIT_UINT)],
    (input) => {
      const array = utils.fromStreamId(input as StreamId);
      const { data: id } = utils.toStreamId(array);
      expect(id).toBe(input);
    },
  );
});
