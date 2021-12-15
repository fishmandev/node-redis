import { strict as assert } from 'assert';
import testUtils, { GLOBAL } from '../../test-utils';
import { transformArguments } from './INFO';

describe('CF INFO', () => {
    it('transformArguments', () => {
        assert.deepEqual(
            transformArguments('cuckoo'),
            ['CF.INFO', 'cuckoo']
        );
    });

    testUtils.testWithClient('client.cf.info', async client => {
        await client.cf.reserve('cuckoo', { capacity: 100 });

        assert.deepEqual(
            await client.cf.info('cuckoo'),
            {
                size: 184,
                numberOfBuckets: 64,
                numberOfFilters: 1,
                numberOfInsertedItems: 0,
                numberOfDeletedItems: 0,
                bucketSize: 2,
                expansionRate: 1,
                maxIteration: 20
            }
        );
    }, GLOBAL.SERVERS.OPEN);
});
