export const FIRST_KEY_INDEX = 1;

export function transformArguments(key: string, iter: number, data: string): Array<string> {
    return ['CF.LOADCHUNK', key, iter.toString(), data];
}

export declare function transformReply(): 'OK';
