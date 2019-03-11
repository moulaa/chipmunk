// List of modules to shate with plugin
import * as AngularCore from '@angular/core';
import * as AngularCommon from '@angular/common';
import * as AngularPlatformBrowser from '@angular/platform-browser';
import * as LogviewerClientComplex from 'logviewer-client-complex';
import * as LogviewerClientContainers from 'logviewer-client-containers';
import * as LogviewerClientPrimitive from 'logviewer-client-primitive';
import * as Toolkit from 'logviewer.client.toolkit';
import * as XTerm from 'xterm';

import { Compiler, Injector } from '@angular/core';
import ElectronIpcService from './service.electron.ipc';
import { IPCMessages, Subscription } from './service.electron.ipc';
import PluginsIPCService from './service.plugins.ipc';
import ControllerPluginIPC from '../controller/controller.plugin.ipc';
import { IService } from '../interfaces/interface.service';

type TPluginModule = any;

export type TRowParser = (str: string) => string;

export interface IPluginData {
    name: string;               // Name of plugin
    token: string;              // Plugin token
    module: TPluginModule;      // Instance of plugin module
    ipc: ControllerPluginIPC;   // Related to plugin IPC
    id: number;                 // ID of plugin
    factories: { [key: string]: any };
    parsers: {
        row: TRowParser | undefined,
        rest: TRowParser | undefined,
    };
}

export class PluginsService extends Toolkit.Emitter implements IService {

    public Events = {
        pluginsLoaded: 'pluginsLoaded'
    };

    private _logger: Toolkit.Logger = new Toolkit.Logger('PluginsService');
    private _compiler: Compiler;
    private _injector: Injector;
    private _plugins: Map<string, IPluginData> = new Map();
    private _subscriptions: { [key: string]: Subscription | undefined } = {
        mountPlugin: undefined,
    };
    private _idsCache: { [key: number]: IPluginData } = {};

    constructor() {
        super();
        this._ipc_onRenderMountPlugin = this._ipc_onRenderMountPlugin.bind(this);
        this._subscriptions.mountPlugin = ElectronIpcService.subscribe(IPCMessages.RenderMountPlugin, this._ipc_onRenderMountPlugin);
    }

    public init(): Promise<void> {
        return new Promise((resolve) => {
            resolve();
        });
    }

    public getName(): string {
        return 'PluginsService';
    }

    public defineCompilerAndInjector(compiler: Compiler, injector: Injector) {
        this._compiler = compiler;
        this._injector = injector;
    }

    public destroy() {
        Object.keys(this._subscriptions).forEach((key: string) => {
            this._subscriptions[key].destroy();
        });
    }

    public getPlugin(name: string): IPluginData | undefined {
        return this._plugins.get(name);
    }

    public getPluginById(id: number): IPluginData | undefined {
        if (this._idsCache[id] !== undefined) {
            return this._idsCache[id];
        }
        let name: string;
        this._plugins.forEach((plugin: IPluginData, pluginName: string) => {
            if (plugin.id === id) {
                name = pluginName;
            }
        });
        if (name === undefined) {
            this._logger.warn(`Fail to find plugin by ID: ${id}`);
            return undefined;
        }
        this._idsCache[id] = this._plugins.get(name);
        return this._idsCache[id];
    }

    private _loadAndInit(name: string, token: string, id: number, location: string): Promise<IPluginData> {
        return new Promise((resolve, reject) => {
            Toolkit.sequences([
                // Step 1. Delivery sources of module
                this._loadAndInit_FetchPlugin.bind(this, name, token, id, location),        // Returns { string } - code of module
                // Steps 2 - 4. Prepare environment and init code of module
                this._loadAndInit_InitPlugin.bind(this, name, token, id, location),         // Returns { [key: string]: any } - all exports of module
                // Steps 5 - 7. Compile code as Angular module, discover shares of module
                this._loadAndInit_CompilePlugin.bind(this, name, token, id, location),      // Returns { IPluginData } - plugin data
            ]).then((pluginData: IPluginData) => {
                resolve(pluginData);
            }).catch((error: Error) => {
                reject(error);
            });
        });
    }

    private _loadAndInit_FetchPlugin(name: string, token: string, id: number, location: string): Promise<string> {
        return new Promise((resolve, reject) => {
            // Step 1. Delivery sources
            fetch(location).then((response: Response) => {
                response.text().then((source: string) => {
                    resolve(source);
                }).catch((responseError: Error) => {
                    reject(new Error(this._logger.error(`Response of plugin "${name}" wasn't parsed correctly due error: ${responseError.message}`)));
                });
            }).catch((fetchError: Error) => {
                reject(new Error(this._logger.error(`Plugin "${name}" wasn't loaded due error: ${fetchError.message}`)));
            });
        });
    }

    private _loadAndInit_InitPlugin(name: string, token: string, id: number, location: string, code: string): Promise<{[key: string]: any}> {
        return new Promise((resolve, reject) => {
            // Step 2. Prepare environment for plugin initialization
            this._logger.env(`Sources of plugin "${name}" was fetch correctly.`);
            const exports: any = {};
            const modules: any = this._getAvailablePluginModules();
            const require = (module) => modules[module]; // shim 'require'
            // Step 3. Execute code of plugin to initialize
            try {
                // tslint:disable-next-line:no-eval
                eval(code);
            } catch (executeError) {
                return reject(new Error(this._logger.error(`Fail to execute plugin "${name}" due error: ${executeError.message}`)));
            }
            // Step 4. Check plugin module
            if (!exports[Toolkit.CModuleName]) {
                return reject(new Error(this._logger.error(`Fail to compile plugin "${name}" because module "${Toolkit.CModuleName}" wasn't found.`)));
            }
            resolve(exports);
        });
    }

    private _loadAndInit_CompilePlugin(name: string, token: string, id: number, location: string, exports: {[key: string]: any}): Promise<IPluginData> {
        return new Promise((resolve, reject) => {
            // Step 5. Compile
            this._compiler.compileModuleAndAllComponentsAsync<any>(exports[Toolkit.CModuleName]).then((mwcf) => {
                // Ok. From here we have access to plugin components. Also all components should be already initialized
                // Step 6. Create plugin module
                try {
                    const module = mwcf.ngModuleFactory.create(this._injector);
                    if (!(module.instance instanceof exports[Toolkit.CModuleName])) {
                        return reject(new Error(this._logger.error(`Fail to compile main module of plugin "${name}".`)));
                    }
                    // Step 7. Search views of apps
                    const pluginData: IPluginData = {
                        name: name,
                        token: token,
                        module: module.instance,
                        ipc: new ControllerPluginIPC(name, token),
                        id: id,
                        factories: {},
                        parsers: {
                            row: exports[Toolkit.EParsers.row],
                            rest: exports[Toolkit.EParsers.rest],
                        },
                    };
                    Object.keys(Toolkit.EViewsTypes).forEach((alias: string) => {
                        const selector: string = Toolkit.EViewsTypes[alias];
                        const componentFactory = mwcf.componentFactories.find(e => e.selector === selector);
                        if (componentFactory) {
                            pluginData.factories[selector] = componentFactory;
                        }
                    });
                    resolve(pluginData);
                } catch (moduleCompileError) {
                    return reject(new Error(this._logger.error(`Fail to compile main module of plugin "${name}" due error: ${moduleCompileError.message}.`)));
                }
            }).catch((compileError: Error) => {
                reject(new Error(this._logger.error(`Fail to compile plugin "${name}" due error: ${compileError.message}`)));
            });
        });
    }

    private _getAvailablePluginModules(): { [key: string]: any } {
        return {
            '@angular/core': AngularCore,
            '@angular/common': AngularCommon,
            '@angular/platform-browser': AngularPlatformBrowser,
            'logviewer-client-complex': LogviewerClientComplex,
            'logviewer-client-containers': LogviewerClientContainers,
            'logviewer-client-primitive': LogviewerClientPrimitive,
            'logviewer.client.toolkit': Toolkit,
            'xterm': XTerm,
        };
    }

    private _deliveryApps(pluginData: IPluginData, name: string, token: string): Promise<IPluginData> {
        return new Promise((resolve) => {
            // Store IPC instance
            PluginsIPCService.addPlugin(token, pluginData.ipc);
            // Setup plugin API
            if (typeof pluginData.module.setAPI === 'function') {
                pluginData.module.setAPI({
                    ipc: pluginData.ipc
                });
            }
            resolve(pluginData);
        });
    }

    private _ipc_onRenderMountPlugin(event: IPCMessages.RenderMountPlugin): void {
        let left: number = event.plugins.length;
        const done = function() {
            left -= 1;
            if (left === 0) {
                this.emit(this.Events.pluginsLoaded);
            }
        }.bind(this);
        event.plugins.forEach((pluginInfo: IPCMessages.IRenderMountPluginInfo) => {
            this._logger.env(`Information about plugin "${pluginInfo.name}" has been gotten. Starting loading & initialization.`);
            this._loadAndInit(pluginInfo.name, pluginInfo.token, pluginInfo.id, pluginInfo.location).then((pluginData: IPluginData) => {
                // Delivery applications of plugin into main application
                this._deliveryApps(pluginData, pluginInfo.name, pluginInfo.token).then((plugin: IPluginData) => {
                    // Save plugin
                    this._plugins.set(plugin.name, plugin);
                    this._logger.env(`Plugin "${pluginInfo.name}" is successfully mount.`);
                    done();
                }).catch((deliveryError: Error) => {
                    this._logger.error(`Fail to delivery applications of plugin "${pluginInfo.name}" due error: ${deliveryError.message}`);
                    done();
                });
            }).catch((loadError: Error) => {
                this._logger.error(`Fail to load and initialize plugin "${pluginInfo.name}" due error: ${loadError.message}`);
                done();
            });
        });
    }

}

export default (new PluginsService());
