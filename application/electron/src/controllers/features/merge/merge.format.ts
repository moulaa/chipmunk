// tslint:disable:max-classes-per-file
import { CancelablePromise, Processor, Progress } from "indexer-neon";

import Logger from "../../../tools/env.logger";
import indexer from "indexer-neon";

export default class MergeFormat {
    private _logger: Logger = new Logger("MergeFormat");
    private _closed: boolean = false;
    private _format: string;
    private _task: CancelablePromise<void, void, Processor.TFormatVerificationAsyncEvents, Processor.TFormatVerificationAsyncEventObject> | undefined;

    constructor(format: string) {
        this._format = format;
    }

    public validate(): Promise<void> {
        return new Promise((resolve, reject) => {
            const measure = this._logger.measure('Validate format');
            let error: string | undefined;
            this._task = indexer.checkFormat(this._format).then(() => {
                measure();
                if (error) {
                    reject(new Error(error));
                } else {
                    resolve();
                }
            }).catch((indxErr: Error) => {
                reject(indxErr);
            }).finally(() => {
                this._task = undefined;
            }).on('chunk', (event: Progress.IFormatCheckResult) => {
                if (typeof event.FormatInvalid === 'string' && event.FormatInvalid.trim() !== '') {
                    error = event.FormatInvalid;
                } else if (typeof event.FormatRegex !== 'string' || event.FormatRegex === '') {
                    error = `Fail to get regexp.`;
                }
            }).on('progress', (event: Progress.ITicks) => {
                this._logger.env(event);
            }).on('notification', (event: Progress.INeonNotification) => {
                this._logger.env(event);
            });
        });
    }

    public destroy(): Promise<void> {
        return this.abort();
    }

    public abort(): Promise<void> {
        return new Promise((resolve) => {
            if (this._task === undefined) {
                return resolve();
            }
            this._task.canceled(() => {
                resolve();
            }).abort();
        });
    }
}
