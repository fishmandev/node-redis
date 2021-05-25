import LinkedList, { Node } from 'yallist';
import RedisParser from 'redis-parser';
import { AbortError } from './errors';

export interface QueueCommandOptions {
    asap?: boolean;
    signal?: AbortSignal;
    chainId?: Symbol;
}

interface CommandWaitingToBeSent extends CommandWaitingForReply {
    encodedCommand: string;
    chainId?: Symbol;
    abort?: {
        signal: AbortSignal;
        listener: () => void
    };
}

interface CommandWaitingForReply {
    resolve: (reply: any) => void;
    reject: (err: Error) => void;
}

export type CommandsQueueExecutor = (encodedCommands: string) => boolean | undefined;

export default class RedisCommandsQueue {
    static encodeCommand(args: Array<string>): string {
        const encoded = [
            `*${args.length}`,
            `$${args[0].length}`,
            args[0]
        ];

        for (let i = 1; i < args.length; i++) {
            const str = args[i].toString();
            encoded.push(`$${str.length}`, str);
        }

        return encoded.join('\r\n') + '\r\n';
    }

    static #flushQueue<T extends CommandWaitingForReply>(queue: LinkedList<T>, err: Error): void {
        while (queue.length) {
            (queue.shift() as T).reject(err);
        }
    }

    readonly #maxLength: number | null | undefined;

    readonly #executor: CommandsQueueExecutor;

    readonly #waitingToBeSent = new LinkedList<CommandWaitingToBeSent>();

    readonly #waitingForReply = new LinkedList<CommandWaitingForReply>();

    readonly #parser = new RedisParser({
        returnReply: (reply: unknown) => this.#shiftWaitingForReply().resolve(reply),
        returnError: (err: Error) => this.#shiftWaitingForReply().reject(err)
    });

    #chainInExecution: Symbol | undefined;

    constructor(maxLength: number | null | undefined, executor: CommandsQueueExecutor) {
        this.#maxLength = maxLength;
        this.#executor = executor;
    }

    #isQueueFull<T = void>(): Promise<T> | undefined {
        if (!this.#maxLength) return;

        return this.#waitingToBeSent.length + this.#waitingForReply.length >= this.#maxLength ?
            Promise.reject(new Error('The queue is full')) :
            undefined;
    }

    addCommand<T = unknown>(args: Array<string>, options?: QueueCommandOptions): Promise<T> {
        return this.#isQueueFull<T>() || this.addEncodedCommand(
            RedisCommandsQueue.encodeCommand(args),
            options
        );
    }

    addEncodedCommand<T = unknown>(encodedCommand: string, options?: QueueCommandOptions): Promise<T> {
        const fullQueuePromise = this.#isQueueFull<T>();
        if (fullQueuePromise) {
            return fullQueuePromise;
        } else if (options?.signal?.aborted) {
            return Promise.reject(new AbortError());
        }

        return new Promise((resolve, reject) => {
            const node = new LinkedList.Node<CommandWaitingToBeSent>({
                encodedCommand,
                chainId: options?.chainId,
                resolve,
                reject
            });

            if (options?.signal) {
                const listener = () => {
                    this.#waitingToBeSent.removeNode(node);
                    node.value.reject(new AbortError());
                };

                if (options.signal.aborted) {
                    return listener();
                }

                node.value.abort = {
                    signal: options.signal,
                    listener
                };
                options.signal.addEventListener('abort', listener, {
                    once: true
                });
            }

            if (options?.asap) {
                this.#waitingToBeSent.unshiftNode(node);
            } else {
                this.#waitingToBeSent.pushNode(node);
            }
        });
    }

    executeChunk(recommendedSize: number): boolean | undefined {
        if (!this.#waitingToBeSent.length) return;

        const encoded: Array<string> = [];
        let size = 0,
            lastCommandChainId: Symbol | undefined;
        for (const {encodedCommand, chainId} of this.#waitingToBeSent) {
            encoded.push(encodedCommand);
            size += encodedCommand.length;
            if (size > recommendedSize) {
                lastCommandChainId = chainId;
                break;
            }
        }

        if (!lastCommandChainId && encoded.length === this.#waitingToBeSent.length) {
            lastCommandChainId = (this.#waitingToBeSent.tail as Node<CommandWaitingToBeSent>).value.chainId;
        }

        lastCommandChainId ??= this.#waitingToBeSent.tail?.value.chainId;

        this.#executor(encoded.join(''));

        for (let i = 0; i < encoded.length; i++) {
            const waitingToBeSent = this.#waitingToBeSent.shift() as CommandWaitingToBeSent;
            if (waitingToBeSent.abort) {
                waitingToBeSent.abort.signal.removeEventListener('abort', waitingToBeSent.abort.listener);
            }

            this.#waitingForReply.push({
                resolve: waitingToBeSent.resolve,
                reject: waitingToBeSent.reject
            });
        }

        this.#chainInExecution = lastCommandChainId;
    }

    parseResponse(data: Buffer): void {
        this.#parser.execute(data);
    }

    #shiftWaitingForReply(): CommandWaitingForReply {
        if (!this.#waitingForReply.length) {
            throw new Error('Got an unexpected reply from Redis');
        }

        return this.#waitingForReply.shift() as CommandWaitingForReply;
    }

    flushWaitingForReply(err: Error): void {
        RedisCommandsQueue.#flushQueue(this.#waitingForReply, err);

        if (!this.#chainInExecution) {
            return;
        }

        while (this.#waitingToBeSent.head?.value.chainId === this.#chainInExecution) {
            this.#waitingToBeSent.shift();
        }

        this.#chainInExecution = undefined;
    }

    flushAll(err: Error): void {
        RedisCommandsQueue.#flushQueue(this.#waitingForReply, err);
        RedisCommandsQueue.#flushQueue(this.#waitingToBeSent, err);
    }
};
