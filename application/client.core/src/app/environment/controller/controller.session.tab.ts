import PluginsService, { IPluginData } from '../services/service.plugins';
import ServiceElectronIpc, { IPCMessages, Subscription } from '../services/service.electron.ipc';
import { ControllerSessionTabStream } from './controller.session.tab.stream';
import { ControllerSessionTabSearch } from './controller.session.tab.search';
import { ControllerSessionTabStreamBookmarks } from './controller.session.tab.stream.bookmarks';
import { TabsService } from 'logviewer-client-complex';
import * as Toolkit from 'logviewer.client.toolkit';

export interface IControllerSession {
    guid: string;
    transports: string[];
    defaultsSideBarApps: Array<{ guid: string, name: string, component: any }>;
}

export interface IComponentInjection {
    factory: any;
    inputs: { [key: string]: any };
}

export interface ISidebarTabOptions {
    active?: boolean;
}

export class ControllerSessionTab {

    private _logger: Toolkit.Logger;
    private _sessionId: string;
    private _transports: string[];
    private _stream: ControllerSessionTabStream;
    private _search: ControllerSessionTabSearch;
    private _sidebarTabsService: TabsService;
    private _defaultsSideBarApps: Array<{ guid: string, name: string, component: any }>;
    private _subscriptions: { [key: string]: Subscription | undefined } = { };

    constructor(params: IControllerSession) {
        this._sessionId = params.guid;
        this._transports = params.transports;
        this._logger = new Toolkit.Logger(`ControllerSession: ${params.guid}`);
        this._stream = new ControllerSessionTabStream({
            guid: params.guid,
            transports: params.transports.slice()
        });
        this._search = new ControllerSessionTabSearch({
            guid: params.guid,
            transports: params.transports.slice(),
            stream: this._stream.getOutputStream()
        });
        this._defaultsSideBarApps = params.defaultsSideBarApps;
        this._sidebar_update();
    }

    public destroy(): Promise<void> {
        return new Promise((resolve, reject) => {
            Object.keys(this._subscriptions).forEach((key: string) => {
                this._subscriptions[key].destroy();
            });
            Promise.all([
                this._stream.destroy(),
                this._search.destroy(),
            ]).then(() => {
                ServiceElectronIpc.request(
                    new IPCMessages.StreamRemoveRequest({ guid: this.getGuid() }),
                    IPCMessages.StreamRemoveResponse
                ).then((response: IPCMessages.StreamRemoveResponse) => {
                    if (response.error) {
                        return reject(new Error(this._logger.warn(`Fail to destroy session "${this.getGuid()}" due error: ${response.error}`)));
                    }
                    resolve();
                }).catch((sendingError: Error) => {
                    reject(new Error(this._logger.warn(`Fail to destroy session "${this.getGuid()}" due IPC error: ${sendingError.message}`)));
                });
            }).catch((error: Error) => {
                reject(error);
            });
        });
    }

    public getGuid(): string {
        return this._sessionId;
    }

    public getSessionStream(): ControllerSessionTabStream {
        return this._stream;
    }

    public getSessionBooksmarks(): ControllerSessionTabStreamBookmarks {
        return this._stream.getBookmarks();
    }

    public getSessionSearch(): ControllerSessionTabSearch {
        return this._search;
    }

    public getSidebarTabsService(): TabsService {
        return this._sidebarTabsService;
    }

    public getOutputBottomInjections(): Map<string, IComponentInjection> {
        const injections: Map<string, IComponentInjection> = new Map();
        this._transports.forEach((pluginName: string) => {
            const plugin: IPluginData | undefined = PluginsService.getPlugin(pluginName);
            if (plugin === undefined) {
                this._logger.warn(`Plugin "${pluginName}" is defined as transport, but doesn't exist in storage.`);
                return;
            }
            if (plugin.factories[Toolkit.EViewsTypes.outputBottom] === undefined) {
                return;
            }
            injections.set(plugin.name, {
                factory: plugin.factories[Toolkit.EViewsTypes.outputBottom],
                inputs: {
                    ipc: plugin.ipc,
                    session: this._sessionId
                }
            });
        });
        return injections;
    }

    public addSidebarApp(name: string, component: any, inputs: { [key: string]: any }, options?: ISidebarTabOptions): string {
        if (options === undefined) {
            options = {};
        }
        // Set defaut options
        options.active = typeof options.active === 'boolean' ? options.active : true;
        // Create tab guid
        const guid: string = Toolkit.guid();
        // Add sidebar tab
        this._sidebarTabsService.add({
            guid: guid,
            name: name,
            active: options.active,
            content: {
                factory: component,
                inputs: inputs
            }
        });
        return guid;
    }

    public openSidebarTab(guid: string): void {
        this._sidebarTabsService.setActive(guid);
    }

    public removeSidebarApp(guid: string): void {
        this._sidebarTabsService.remove(guid);
    }

    public resetSessionContent(): Promise<void> {
        return new Promise((resolve, reject) => {
            ServiceElectronIpc.request(new IPCMessages.StreamResetRequest({
                guid: this._sessionId,
            }), IPCMessages.StreamResetResponse).then((response: IPCMessages.StreamResetResponse) => {
                this.getSessionBooksmarks().reset();
                resolve();
            }).catch((error: Error) => {
                reject(error);
            });
        });
    }

    private _sidebar_update() {
        if (this._sidebarTabsService !== undefined) {
            // Drop previous if was defined
            this._sidebarTabsService.clear();
        }
        // Create new tabs service
        this._sidebarTabsService = new TabsService();
        // Add default sidebar apps
        this._defaultsSideBarApps.forEach((app, index) => {
            // Add tab to sidebar
            this._sidebarTabsService.add({
                guid: app.guid !== undefined ? app.guid : Toolkit.guid(),
                name: app.name,
                active: index === 0,
                content: {
                    factory: app.component,
                    resolved: false,
                    inputs: {
                        session: this._sessionId,
                    }
                }
            });
        });
        // Detect tabs related to transports (plugins)
        this._transports.forEach((pluginName: string, index: number) => {
            const plugin: IPluginData | undefined = PluginsService.getPlugin(pluginName);
            if (plugin === undefined) {
                this._logger.warn(`Plugin "${pluginName}" is defined as transport, but doesn't exist in storage.`);
                return;
            }
            if (plugin.factories[Toolkit.EViewsTypes.sidebarVertical] === undefined) {
                return;
            }
            // Add tab to sidebar
            this._sidebarTabsService.add({
                guid: Toolkit.guid(),
                name: plugin.name,
                active: false,
                content: {
                    factory: plugin.factories[Toolkit.EViewsTypes.sidebarVertical],
                    resolved: true,
                    inputs: {
                        session: this._sessionId,
                        ipc: plugin.ipc
                    }
                }
            });
        });
    }

}
