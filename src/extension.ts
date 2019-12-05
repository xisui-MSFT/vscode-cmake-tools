/**
 * Extension startup/teardown
 */ /** */

'use strict';

import * as chokidar from 'chokidar';
import * as path from 'path';
import * as vscode from 'vscode';
import * as cpt from 'vscode-cpptools';
import * as nls from 'vscode-nls';

import * as api from '@cmt/api';
import {CMakeCache} from '@cmt/cache';
import CMakeTools from '@cmt/cmake-tools';
import {ConfigurationReader} from '@cmt/config';
import {CppConfigurationProvider} from '@cmt/cpptools';
import {CMakeToolsFolderController, CMakeToolsFolder} from '@cmt/folders';
import {
  Kit,
  USER_KITS_FILEPATH,
  findCLCompilerPath,
  effectiveKitEnvironment,
} from '@cmt/kit';
import {KitsController} from '@cmt/kitsController';
import * as logging from '@cmt/logging';
import {fs} from '@cmt/pr';
import {FireNow, FireLate} from '@cmt/prop';
import rollbar from '@cmt/rollbar';
import {StatusBar} from '@cmt/status';
import {ProjectOutlineProvider, TargetNode, SourceFileNode} from '@cmt/tree';
import * as util from '@cmt/util';
import {ProgressHandle, DummyDisposable, reportProgress} from '@cmt/util';
import {DEFAULT_VARIANTS} from '@cmt/variant';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = logging.createLogger('extension');

type CMakeToolsMapFn = (cmt: CMakeTools) => Thenable<any>;
type CMakeToolsQueryMapFn = (cmt: CMakeTools) => Thenable<string | null>;

/**
 * A class to manage the extension.
 *
 * Yeah, yeah. It's another "Manager", but this is to be the only one.
 *
 * This is the true "singleton" of the extension. It acts as the glue between
 * the lower layers and the VSCode UX. When a user presses a button to
 * necessitate user input, this class acts as intermediary and will send
 * important information down to the lower layers.
 */
class ExtensionManager implements vscode.Disposable {
  constructor(public readonly extensionContext: vscode.ExtensionContext) {
    this._statusBar.targetName = 'all';
    this._folders.onAfterAddFolder(info => {
      if (vscode.workspace.workspaceFolders?.length === 1) {
        // First folder added
        this._setActiveFolder(vscode.workspace.workspaceFolders[0]);
      }
      const new_cmt = info.cmakeTools;
      this._projectOutlineProvider.addFolder(info.folder);
      if (this._codeModelUpdateSubs.get(new_cmt.folder.uri.fsPath)) {
        // We already have this folder, do nothing
      } else {
        let subs: vscode.Disposable[] = [];
        subs.push(new_cmt.onCodeModelChanged(FireLate, () => this._updateCodeModel(info)));
        subs.push(new_cmt.onTargetNameChanged(FireLate, () => this._updateCodeModel(info)));
        subs.push(new_cmt.onLaunchTargetNameChanged(FireLate, () => this._updateCodeModel(info)));
        this._codeModelUpdateSubs.set(new_cmt.folder.uri.fsPath, subs);
      }
      rollbar.takePromise('Post-folder-open', {folder: info.folder}, this._postWorkspaceOpen(info));
    });
    this._folders.onAfterRemoveFolder (info => {
      this._codeModelUpdateSubs.delete(info.uri.fsPath);
      if (!vscode.workspace.workspaceFolders?.length) {
        this._setActiveFolder(undefined);
      } else if (this._folders.activeFolder?.folder.uri.fsPath === info.uri.fsPath) {
        this._setActiveFolder(vscode.workspace.workspaceFolders[0]);
      }
      this._projectOutlineProvider.removeFolder(info);
    });
  }

  private _onDidChangeActiveTextEditorSub: vscode.Disposable = new DummyDisposable();

  private _workspaceConfig: ConfigurationReader = ConfigurationReader.create();

  /**
   * Second-phase async init
   */
  private async _init() {
    if (vscode.workspace.workspaceFolders) {
      await this._folders.loadAllCurrent();
      this._projectOutlineProvider.addAllCurrentFolders();
      this._onDidChangeActiveTextEditorSub = vscode.window.onDidChangeActiveTextEditor(this._onDidChangeActiveTextEditor, this);
      await this._initActiveFolder();
      for (const cmtFolder of this._folders) {
        this._codeModelUpdateSubs.set(cmtFolder.folder.uri.fsPath, [
          cmtFolder.cmakeTools.onCodeModelChanged(FireLate, () => this._updateCodeModel(cmtFolder)),
          cmtFolder.cmakeTools.onTargetNameChanged(FireLate, () => this._updateCodeModel(cmtFolder)),
          cmtFolder.cmakeTools.onLaunchTargetNameChanged(FireLate, () => this._updateCodeModel(cmtFolder))
        ]);
        rollbar.takePromise('Post-folder-open', {folder: cmtFolder.folder}, this._postWorkspaceOpen(cmtFolder));
      }
    }
  }

  /**
   * Create a new extension manager instance. There must only be one!
   * @param ctx The extension context
   */
  static async create(ctx: vscode.ExtensionContext) {
    const inst = new ExtensionManager(ctx);
    await inst._init();
    return inst;
  }

  /**
   * The folder controller manages multiple instances. One per folder.
   */
  private readonly _folders = new CMakeToolsFolderController(this.extensionContext);

  /**
   * The status bar controller
   */
  private readonly _statusBar = new StatusBar();
  // Subscriptions for status bar items:
  private _statusMessageSub: vscode.Disposable = new DummyDisposable();
  private _targetNameSub: vscode.Disposable = new DummyDisposable();
  private _buildTypeSub: vscode.Disposable = new DummyDisposable();
  private _launchTargetSub: vscode.Disposable = new DummyDisposable();
  private _ctestEnabledSub: vscode.Disposable = new DummyDisposable();
  private _testResultsSub: vscode.Disposable = new DummyDisposable();
  private _isBusySub: vscode.Disposable = new DummyDisposable();

  // Watch the code model so that we may update teh tree view
  // <fspath, sub>
  private _codeModelUpdateSubs = new Map<string, vscode.Disposable[]>();

  /**
   * The project outline tree data provider
   */
  private readonly _projectOutlineProvider = new ProjectOutlineProvider();
  private readonly _projectOutlineDisposer
      = vscode.window.registerTreeDataProvider('cmake.outline', this._projectOutlineProvider);

  /**
   * CppTools project configuration provider. Tells cpptools how to search for
   * includes, preprocessor defs, etc.
   */
  private readonly _configProvider = new CppConfigurationProvider();
  private _cppToolsAPI?: cpt.CppToolsApi;
  private _configProviderRegister?: Promise<void>;

  private _checkFolderArgs(folder?: vscode.WorkspaceFolder): CMakeToolsFolder | undefined {
    let cmtFolder: CMakeToolsFolder | undefined;
    if (folder) {
      cmtFolder = this._folders.get(folder);
    } else if (this._folders.activeFolder) {
      cmtFolder = this._folders.activeFolder;
    }
    return cmtFolder;
  }

  private _checkStringFolderArgs(folder: vscode.WorkspaceFolder | string): vscode.WorkspaceFolder | undefined {
    if (util.isString(folder)) {
      return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(<string>folder));
    }
    return <vscode.WorkspaceFolder>folder;
  }

  private async _pickFolder() {
    const selection = await vscode.window.showWorkspaceFolderPick();
    if (selection) {
      const cmtFolder = this._folders.get(selection);
      console.assert(cmtFolder, 'Folder not found in folder controller.');
      return cmtFolder;
    }
  }

  /**
   * Ensure that there is an active kit for the current CMakeTools.
   *
   * @returns `false` if there is not active CMakeTools, or it has no active kit
   * and the user cancelled the kit selection dialog.
   */
  private async _ensureActiveKit(cmt?: CMakeTools): Promise<boolean> {
    if (!cmt) {
      cmt = this._folders.activeFolder?.cmakeTools;
    }
    if (!cmt) {
      // No CMakeTools. Probably no workspace open.
      return false;
    }
    if (cmt.activeKit) {
      // We have an active kit. We're good.
      return true;
    }
    // No kit? Ask the user what they want.
    const did_choose_kit = await this.selectKit();
    if (!did_choose_kit && !cmt.activeKit) {
      // The user did not choose a kit and kit isn't set in other way such as setKitByName
      return false;
    }
    // Return whether we have an active kit defined.
    return !!cmt.activeKit;
  }

  /**
   * Dispose of the CMake Tools extension.
   *
   * If you can, prefer to call `asyncDispose`, which awaits on the children.
   */
  dispose() { rollbar.invokeAsync(localize('dispose.cmake.tools', 'Dispose of CMake Tools'), () => this.asyncDispose()); }

  /**
   * Asynchronously dispose of all the child objects.
   */
  async asyncDispose() {
    this._disposeSubs();
    this._codeModelUpdateSubs.forEach(
      (subs) => {
        for (const sub of subs) {
          sub.dispose();
        }
      }
    );
    this._onDidChangeActiveTextEditorSub.dispose();
    this._kitsWatcher.close();
    this._projectOutlineDisposer.dispose();
    if (this._cppToolsAPI) {
      this._cppToolsAPI.dispose();
    }
    // Dispose of each CMake Tools we still have loaded
    for (const cmtf of this._folders) {
      await cmtf.cmakeTools.asyncDispose();
    }
    this._folders.dispose();
  }

  async _postWorkspaceOpen(info: CMakeToolsFolder) {
    const ws = info.folder;
    const cmt = info.cmakeTools;
    let should_configure = cmt.workspaceContext.config.configureOnOpen;
    if (should_configure === null && process.env['CMT_TESTING'] !== '1') {
      interface Choice1 {
        title: string;
        doConfigure: boolean;
      }
      const chosen = await vscode.window.showInformationMessage<Choice1>(
          localize('configure.this.project', 'Would you like to configure this project?'),
          {},
          {title: localize('yes.button', 'Yes'), doConfigure: true},
          {title: localize('not.now.button', 'Not now'), doConfigure: false},
      );
      if (!chosen) {
        // Do nothing. User cancelled
        return;
      }
      const perist_message
          = chosen.doConfigure ?
            localize('always.configure.on.open', 'Always configure projects upon opening?') :
            localize('never.configure.on.open', 'Never configure projects on opening?');
      interface Choice2 {
        title: string;
        persistMode: 'user'|'workspace';
      }
      const persist_pr
          // Try to persist the user's selection to a `settings.json`
          = vscode.window
                .showInformationMessage<Choice2>(
                    perist_message,
                    {},
                    {title: localize('yes.button', 'Yes'), persistMode: 'user'},
                    {title: localize('for.this.workspace.button', 'For this Workspace'), persistMode: 'workspace'},
                    )
                .then(async choice => {
                  if (!choice) {
                    // Use cancelled. Do nothing.
                    return;
                  }
                  const config = vscode.workspace.getConfiguration(undefined, ws.uri);
                  let config_target = vscode.ConfigurationTarget.Global;
                  if (choice.persistMode === 'workspace') {
                    config_target = vscode.ConfigurationTarget.WorkspaceFolder;
                  }
                  await config.update('cmake.configureOnOpen', chosen.doConfigure, config_target);
                });
      rollbar.takePromise(localize('persist.config.on.open.setting', 'Persist config-on-open setting'), {}, persist_pr);
      should_configure = chosen.doConfigure;
    }
    if (should_configure) {
      // We've opened a new workspace folder, and the user wants us to
      // configure it now.
      log.debug(localize('configuring.workspace.on.open', 'Configuring workspace on open {0}', ws.uri.toString()));
      // Ensure that there is a kit. This is required for new instances.
      if (!await this._ensureActiveKit(cmt)) {
        return;
      }
      await cmt.configure();
    }
    this._updateCodeModel(info);
  }

  private async _onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (vscode.workspace.workspaceFolders) {
      let ws: vscode.WorkspaceFolder | undefined;
      if (editor) {
        ws = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      }
      if (ws && (!this._folders.activeFolder || ws.uri.fsPath !== this._folders.activeFolder.folder.uri.fsPath)) {
        // active folder changed.
        await this._setActiveFolder(ws);
      }
    }
  }

  /**
   * Show UI to allow the user to select an active kit
   */
  async selectActiveFolder() {
    if (vscode.workspace.workspaceFolders?.length && !this._workspaceConfig.autoSelectActiveFolder) {
      const lastActiveFolderPath = this._folders.activeFolder?.folder.uri.fsPath;
      const selection = await vscode.window.showWorkspaceFolderPick();
      if (selection) {
        // Ingore if user cancelled
        await this._setActiveFolder(selection);
        // _folders.activeFolder must be there at this time
        const currentActiveFolderPath = this._folders.activeFolder!.folder.uri.fsPath;
        this.extensionContext.workspaceState.update('activeFolder', currentActiveFolderPath);
        if (lastActiveFolderPath !== currentActiveFolderPath) {
          rollbar.takePromise('Post-folder-open', {folder: selection}, this._postWorkspaceOpen(this._folders.activeFolder!));
        }
      }
    }
  }

  private async _initActiveFolder() {
    if (vscode.window.activeTextEditor && this._workspaceConfig.autoSelectActiveFolder) {
       return await this._onDidChangeActiveTextEditor(vscode.window.activeTextEditor);
    }
    const path = this.extensionContext.workspaceState.get<string>('activeFolder');
    let folder: vscode.WorkspaceFolder | undefined;
    if (path) {
      folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(path));
    }
    if (!folder) {
      folder = vscode.workspace.workspaceFolders![0];
    }
    await this._setActiveFolder(folder);
  }

  /**
   * Set the active workspace folder. This reloads a lot of different bits and
   * pieces to control which backend has control and receives user input.
   * @param ws The workspace to activate
   */
  private async _setActiveFolder(ws: vscode.WorkspaceFolder | undefined, progress?: ProgressHandle) {
    // Set the new workspace
    this._folders.setActiveFolder(ws);
    this._statusBar.setActiveFolderName(ws?.name || '');
    this._statusBar.setActiveKitName(this._folders.activeFolder?.cmakeTools.activeKit?.name || '');
    this._setupSubscriptions();
  }

  private _disposeSubs() {
    for (const sub of [this._statusMessageSub,
                       this._targetNameSub,
                       this._buildTypeSub,
                       this._launchTargetSub,
                       this._ctestEnabledSub,
                       this._testResultsSub,
                       this._isBusySub,
    ]) {
      sub.dispose();
    }
  }

  private _updateCodeModel(folder: CMakeToolsFolder) {
    const cmt = folder.cmakeTools;
    this._projectOutlineProvider.updateCodeModel(
      cmt.workspaceContext.folder,
      cmt.codeModel,
      {
        defaultTarget: cmt.defaultBuildTarget || undefined,
        launchTargetName: cmt.launchTargetName,
      }
    );
    rollbar.invokeAsync(localize('update.code.model.for.cpptools', 'Update code model for cpptools'), {}, async () => {
      if (!this._cppToolsAPI) {
        this._cppToolsAPI = await cpt.getCppToolsApi(cpt.Version.v2);
      }
      if (this._cppToolsAPI && cmt.codeModel && cmt.activeKit) {
        const codeModel = cmt.codeModel;
        const kit = cmt.activeKit;
        const cpptools = this._cppToolsAPI;
        let cache: CMakeCache;
        try {
          cache = await CMakeCache.fromPath(await cmt.cachePath);
        } catch (e) {
          rollbar.exception(localize('filed.to.open.cache.file.on.code.model.update', 'Failed to open CMake cache file on code model update'), e);
          return;
        }
        const drv = await cmt.getCMakeDriverInstance();
        const opts = drv ? drv.expansionOptions : undefined;
        const env = await effectiveKitEnvironment(kit, opts);
        const clCompilerPath = await findCLCompilerPath(env);
        this._configProvider.updateConfigurationData({cache, codeModel, clCompilerPath});
        await this.ensureCppToolsProviderRegistered();
        if (cpptools.notifyReady) {
          cpptools.notifyReady(this._configProvider);
        } else {
          cpptools.didChangeCustomConfiguration(this._configProvider);
        }
      }
    });
  }

  private _setupSubscriptions() {
    this._disposeSubs();
    const folder = this._folders.activeFolder;
    const cmt = folder?.cmakeTools;
    if (!cmt) {
      this._statusBar.setVisible(false);
      this._statusMessageSub = new DummyDisposable();
      this._targetNameSub = new DummyDisposable();
      this._buildTypeSub = new DummyDisposable();
      this._launchTargetSub = new DummyDisposable();
      this._ctestEnabledSub = new DummyDisposable();
      this._testResultsSub = new DummyDisposable();
      this._isBusySub = new DummyDisposable();
      this._statusBar.setActiveKitName('');
    } else {
      this._statusBar.setVisible(true);
      this._statusMessageSub = cmt.onStatusMessageChanged(FireNow, s => this._statusBar.setStatusMessage(s));
      this._targetNameSub = cmt.onTargetNameChanged(FireNow, t => {
        this._statusBar.targetName = t;
      });
      this._buildTypeSub = cmt.onBuildTypeChanged(FireNow, bt => this._statusBar.setBuildTypeLabel(bt));
      this._launchTargetSub = cmt.onLaunchTargetNameChanged(FireNow, t => {
        this._statusBar.setLaunchTargetName(t || '');
      });
      this._ctestEnabledSub = cmt.onCTestEnabledChanged(FireNow, e => this._statusBar.ctestEnabled = e);
      this._testResultsSub = cmt.onTestResultsChanged(FireNow, r => this._statusBar.testResults = r);
      this._isBusySub = cmt.onIsBusyChanged(FireNow, b => this._statusBar.setIsBusy(b));
      this._statusBar.setActiveKitName(cmt.activeKit ? cmt.activeKit.name : '');
    }
  }

  /**
   * Watches for changes to the kits file
   */
  private readonly _kitsWatcher =
      util.chokidarOnAnyChange(chokidar.watch(USER_KITS_FILEPATH, {ignoreInitial: true}),
                               _ => rollbar.takePromise(localize('rereading.kits', 'Re-reading kits'), {}, KitsController.readUserKits()));

  /**
   * Set the current kit for the specified workspace folder
   * @param k The kit
   */
  async _setFolderKit(wsf: vscode.WorkspaceFolder, k: Kit|null) {
    const cmtFolder = this._folders.get(wsf);
    // Ignore if folder doesn't exist
    if (cmtFolder) {
      this._statusBar.setActiveKitName(await cmtFolder.kitsController.setFolderActiveKit(k));
    }
  }

  /**
   * Opens a text editor with the user-local `cmake-kits.json` file.
   */
  async editKits(): Promise<vscode.TextEditor|null> {
    log.debug(localize('opening.text.editor.for', 'Opening text editor for {0}', USER_KITS_FILEPATH));
    if (!await fs.exists(USER_KITS_FILEPATH)) {
      interface Item extends vscode.MessageItem {
        action: 'scan'|'cancel';
      }
      const chosen = await vscode.window.showInformationMessage<Item>(
          localize('no.kits.file.what.to.do', 'No kits file is present. What would you like to do?'),
          {modal: true},
          {
            title: localize('scan.for.kits.button', 'Scan for kits'),
            action: 'scan',
          },
          {
            title: localize('cancel.button', 'Cancel'),
            isCloseAffordance: true,
            action: 'cancel',
          },
      );
      if (!chosen || chosen.action === 'cancel') {
        return null;
      } else {
        await this.scanForKits();
        return this.editKits();
      }
    }
    const doc = await vscode.workspace.openTextDocument(USER_KITS_FILEPATH);
    return vscode.window.showTextDocument(doc);
  }

  async scanForKits() {
    KitsController.minGWSearchDirs = this._getMinGWDirs();
    const duplicateRemoved = await KitsController.scanForKits();
    if (duplicateRemoved) {
      // Check each folder. If there is an active kit set and if it is of the old definition,
      // unset the kit
      for (const cmtFolder of this._folders) {
        const activeKit = cmtFolder.cmakeTools.activeKit;
        if (activeKit) {
          const definition = activeKit.visualStudio;
          if (definition && (definition.startsWith("VisualStudio.15") || definition.startsWith("VisualStudio.16"))) {
            await cmtFolder.kitsController.setFolderActiveKit(null);
          }
        }
      }
    }
  }

  /**
   * Get the current MinGW search directories
   */
  private _getMinGWDirs(): string[] {
    let result = new Set<string>();
    for (const dir of this._workspaceConfig.mingwSearchDirs) {
      result.add(dir);
    }
    for (const cmtFolder of this._folders) {
      for (const dir of cmtFolder.cmakeTools.workspaceContext.config.mingwSearchDirs) {
        result.add(dir);
      }
    }
    return Array.from(result);
  }

  /**
   * Show UI to allow the user to select an active kit
   */
  async selectKit(folder?: vscode.WorkspaceFolder): Promise<boolean> {
    if (process.env['CMT_TESTING'] === '1') {
      log.trace(localize('running.in.test.mode', 'Running CMakeTools in test mode. selectKit is disabled.'));
      return false;
    }

    const cmtFolder = this._checkFolderArgs(folder);
    if (!cmtFolder) {
      return false;
    }

    const kitName = await cmtFolder.kitsController.selectKit();

    if (this._folders.activeFolder && this._folders.activeFolder.cmakeTools.activeKit) {
      this._statusBar.setActiveKitName(this._folders.activeFolder.cmakeTools.activeKit.name);
    }

    if (kitName) {
      return true;
    }
    return false;
  }

  /**
   * Set the current kit used in the specified folder by name of the kit
   * For backward compatibility, apply kitName to all folders if folder is undefined
   */
  async setKitByName(kitName: string, folder?: vscode.WorkspaceFolder) {
    if (folder) {
      await this._folders.get(folder)?.kitsController.setKitByName(kitName);
    } else {
      for (const cmtFolder of this._folders) {
        await cmtFolder.kitsController.setKitByName(kitName);
      }
    }
    if (this._folders.activeFolder && this._folders.activeFolder.cmakeTools.activeKit) {
      this._statusBar.setActiveKitName(this._folders.activeFolder.cmakeTools.activeKit.name);
    }
  }

  async ensureCppToolsProviderRegistered() {
    if (!this._configProviderRegister) {
      this._configProviderRegister = this._doRegisterCppTools();
    }
    return this._configProviderRegister;
  }

  async _doRegisterCppTools() {
    if (!this._cppToolsAPI) {
      return;
    }
    this._cppToolsAPI.registerCustomConfigurationProvider(this._configProvider);
  }

  // The below functions are all wrappers around the backend.
  async mapCMakeTools(fn: CMakeToolsMapFn): Promise<any>;
  async mapCMakeTools(cmt: CMakeTools|undefined, fn: CMakeToolsMapFn): Promise<any>;
  async mapCMakeTools(cmt: CMakeTools|undefined|CMakeToolsMapFn, fn?: CMakeToolsMapFn): Promise<any> {
    if (cmt === undefined) {
      const activeFolder = this._folders.activeFolder;
      if (activeFolder) {
        if (await this._ensureActiveKit(activeFolder.cmakeTools)) {
          return await fn!(activeFolder.cmakeTools);
        }
        return Promise.resolve(-1);
      }
      rollbar.error(localize('no.active.folder', 'No active foler.'));
      return 0;
    } else if (cmt instanceof CMakeTools) {
      if (await this._ensureActiveKit(cmt)) {
        return await fn!(cmt);
      }
      return Promise.resolve(-1);
    } else {
      fn = cmt;
      for (const folder of this._folders) {
        if (await this._ensureActiveKit(folder.cmakeTools)) {
          const retc = await fn(folder.cmakeTools);
          if (retc) {
            return retc;
          }
        } else {
          return Promise.resolve(-1);
        }
      }
      // Succeeded
      return 0;
    }
  }

  async mapCMakeToolsFolder(folder: vscode.WorkspaceFolder|undefined, fn: CMakeToolsMapFn): Promise<any> {
    this.mapCMakeTools(this._folders.get(folder)?.cmakeTools, fn);
  }

  mapQueryCMakeTools(folder: vscode.WorkspaceFolder | string, fn: CMakeToolsQueryMapFn) {
    const workspaceFolder = this._checkStringFolderArgs(folder);
    if (workspaceFolder) {
      const cmtFolder = this._folders.get(workspaceFolder);
      if (cmtFolder) {
        return fn(cmtFolder.cmakeTools);
      }
    } else {
      rollbar.error(localize('invalid.folder', 'Invalid folder.'));
    }
    return Promise.resolve(null);
  }

  cleanConfigure(folder?: vscode.WorkspaceFolder) { return this.mapCMakeToolsFolder(folder, cmt => cmt.cleanConfigure()); }

  cleanConfigureAll() { return this.mapCMakeTools(cmt => cmt.cleanConfigure()); }

  configure(folder?: vscode.WorkspaceFolder) { return this.mapCMakeToolsFolder(folder, cmt => cmt.configure()); }

  configureAll() { return this.mapCMakeTools(cmt => cmt.configure()); }

  async build(folder?: vscode.WorkspaceFolder, name?: string) { return await this.mapCMakeToolsFolder(folder, cmt => cmt.build(name)); }

  async buildAll(name?: string) { return await this.mapCMakeTools(cmt => cmt.build(name)); }

  async setDefaultTarget(folder?: vscode.WorkspaceFolder, name?: string) { return await this.mapCMakeToolsFolder(folder, cmt => cmt.setDefaultTarget(name)); }

  async setVariant(folder?: vscode.WorkspaceFolder, name?: string) { return await this.mapCMakeToolsFolder(folder, cmt => cmt.setVariant(name)); }

  async setVariantAll() {
    // Only supports default variants for now
    let variantItems: vscode.QuickPickItem[] = [];
    const choices = DEFAULT_VARIANTS.buildType!.choices;
    for (const key in choices) {
      variantItems.push({
        label: choices[key]!.short,
        description: choices[key]!.long
      });
    }
    const choice = await vscode.window.showQuickPick(variantItems);
    if (choice) {
      return await this.mapCMakeTools(cmt => cmt.setVariant(choice.label));
    }
    return false;
  }

  install(folder?: vscode.WorkspaceFolder) { return this.mapCMakeToolsFolder(folder, cmt => cmt.install()); }

  installAll() { return this.mapCMakeTools(cmt => cmt.install()); }

  editCache(folder: vscode.WorkspaceFolder) { return this.mapCMakeToolsFolder(folder, cmt => cmt.editCache()); }

  clean(folder?: vscode.WorkspaceFolder) { return this.build(folder, 'clean'); }

  cleanAll() { return this.buildAll('clean'); }

  async cleanRebuild(folder?: vscode.WorkspaceFolder) {
    const retc = await this.build(folder, 'clean');
    if (retc) {
      return retc;
    }
    return this.build(folder);
  }

  async cleanRebuildAll() {
    const retc = await this.buildAll('clean');
    if (retc) {
      return retc;
    }
    return this.buildAll();
  }

  async buildWithTarget() {
    let cmtFolder: CMakeToolsFolder | undefined = this._folders.activeFolder;
    if (!cmtFolder) {
      cmtFolder = await this._pickFolder();
    }
    if (!cmtFolder) {
      return; // Error or nothing is opened
    }
    cmtFolder.cmakeTools.buildWithTarget();
  }

  /**
   * Compile a single source file.
   * @param file The file to compile. Either a file path or the URI to the file.
   * If not provided, compiles the file in the active text editor.
   */
  async compileFile(file?: string|vscode.Uri) {
    if (file instanceof vscode.Uri) {
      file = file.fsPath;
    }
    if (!file) {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return null;
      }
      file = editor.document.uri.fsPath;
    }
    for (const folder of this._folders) {
      const term = await folder.cmakeTools.tryCompileFile(file);
      if (term) {
        return term;
      }
    }
    vscode.window.showErrorMessage(localize('compilation information.not.found', 'Unable to find compilation information for this file'));
  }

  ctest(folder?: vscode.WorkspaceFolder) { return this.mapCMakeToolsFolder(folder, cmt => cmt.ctest()); }

  ctestAll() { return this.mapCMakeTools(cmt => cmt.ctest()); }

  stop(folder?: vscode.WorkspaceFolder) { return this.mapCMakeToolsFolder(folder, cmt => cmt.stop()); }

  stopAll() { return this.mapCMakeTools(cmt => cmt.stop()); }

  quickStart(folder?: vscode.WorkspaceFolder) {
    const cmtFolder = this._checkFolderArgs(folder);
    return this.mapCMakeTools(cmt => cmt.quickStart(cmtFolder));
  }

  launchTargetPath(folder: vscode.WorkspaceFolder | string) { return this.mapQueryCMakeTools(folder, cmt => cmt.launchTargetPath()); }

  launchTargetDirectory(folder: vscode.WorkspaceFolder | string) { return this.mapQueryCMakeTools(folder,cmt => cmt.launchTargetDirectory()); }

  buildType(folder: vscode.WorkspaceFolder | string) { return this.mapQueryCMakeTools(folder, cmt => cmt.currentBuildType()); }

  buildDirectory(folder: vscode.WorkspaceFolder | string) { return this.mapQueryCMakeTools(folder, cmt => cmt.buildDirectory()); }

  tasksBuildCommand(folder: vscode.WorkspaceFolder | string) { return this.mapQueryCMakeTools(folder, cmt => cmt.tasksBuildCommand()); }

  async debugTarget(folder?: vscode.WorkspaceFolder, name?: string): Promise<vscode.DebugSession | null> { return this.mapCMakeToolsFolder(folder, cmt => cmt.debugTarget(name)); }

  async debugTargetAll(name?: string): Promise<(vscode.DebugSession | null)[]> {
    const debugSessions: Promise<vscode.DebugSession | null>[] = [];
    for (const cmtFolder of this._folders) {
      if (cmtFolder) {
        debugSessions.push(this.mapCMakeTools(cmtFolder.cmakeTools, cmt => cmt.debugTarget(name)));
      }
      debugSessions.push(Promise.resolve(null));
    }
    return Promise.all(debugSessions);
  }

  async launchTarget(folder?: vscode.WorkspaceFolder, name?: string): Promise<vscode.Terminal | null> { return this.mapCMakeToolsFolder(folder, cmt => cmt.launchTarget(name)); }

  async launchTargetAll(name?: string): Promise<(vscode.Terminal | null)[]> {
    const terminals: Promise<vscode.Terminal | null>[] = [];
    for (const cmtFolder of this._folders) {
      if (cmtFolder) {
        terminals.push(this.mapCMakeTools(cmtFolder.cmakeTools, cmt => cmt.launchTarget(name)));
      }
      terminals.push(Promise.resolve(null));
    }
    return Promise.all(terminals);
  }

  selectLaunchTarget(folder?: vscode.WorkspaceFolder, name?: string) { return this.mapCMakeToolsFolder(folder, cmt => cmt.selectLaunchTarget(name)); }

  resetState(folder?: vscode.WorkspaceFolder) { return this.mapCMakeToolsFolder(folder, cmt => cmt.resetState()); }

  async viewLog() { await logging.showLogFile(); }
}

/**
 * The global extension manager. There is only one of these, even if multiple
 * backends.
 */
let _EXT_MANAGER: ExtensionManager|null = null;

async function setup(context: vscode.ExtensionContext, progress: ProgressHandle) {
  reportProgress(progress, localize('initial.setup', 'Initial setup'));
  await util.setContextValue('cmakeToolsActive', true);
  // Load a new extension manager
  const ext = _EXT_MANAGER = await ExtensionManager.create(context);

  // A register function that helps us bind the commands to the extension
  function register<K extends keyof ExtensionManager>(name: K) {
    return vscode.commands.registerCommand(`cmake.${name}`, (...args: any[]) => {
      // Generate a unqiue ID that can be correlated in the log file.
      const id = util.randint(1000, 10000);
      // Create a promise that resolves with the command.
      const pr = (async () => {
        // Debug when the commands start/stop
        log.debug(`[${id}]`, `cmake.${name}`, localize('started', 'started'));
        // Bind the method
        const fn = (ext[name] as Function).bind(ext);
        // Call the method
        const ret = await fn(...args);
        try {
          // Log the result of the command.
          log.debug(localize('cmake.finished.returned', '{0} finished (returned {1})', `[${id}] cmake.${name}`, JSON.stringify(ret)));
        } catch (e) {
          // Log, but don't try to serialize the return value.
          log.debug(localize('cmake.finished.returned.unserializable', '{0} finished (returned an unserializable value)', `[${id}] cmake.${name}`));
        }
        // Return the result of the command.
        return ret;
      })();
      // Hand the promise to rollbar.
      rollbar.takePromise(name, {}, pr);
      // Return the promise so that callers will get the result of the command.
      return pr;
    });
  }

  // List of functions that will be bound commands
  const funs: (keyof ExtensionManager)[] = [
    'selectActiveFolder',
    'editKits',
    'scanForKits',
    'selectKit',
    'setKitByName',
    'build',
    'buildAll',
    'buildWithTarget',
    'setVariant',
    'setVariantAll',
    'install',
    'installAll',
    'editCache',
    'clean',
    'cleanAll',
    'cleanConfigure',
    'cleanConfigureAll',
    'cleanRebuild',
    'cleanRebuildAll',
    'configure',
    'configureAll',
    'ctest',
    'ctestAll',
    'stop',
    'stopAll',
    'quickStart',
    'launchTargetPath',
    'launchTargetDirectory',
    'buildType',
    'buildDirectory',
    'debugTarget',
    'debugTargetAll',
    'launchTarget',
    'launchTargetAll',
    'selectLaunchTarget',
    'setDefaultTarget',
    'resetState',
    'viewLog',
    'compileFile',
    'tasksBuildCommand'
    // 'toggleCoverageDecorations', // XXX: Should coverage decorations be revived?
  ];

  // Register the functions before the extension is done loading so that fast
  // fingers won't cause "unregistered command" errors while CMake Tools starts
  // up. The command wrapper will await on the extension promise.
  reportProgress(progress, localize('loading.extension.commands', 'Loading extension commands'));
  for (const key of funs) {
    log.trace(localize('register.command', 'Register CMakeTools extension command {0}', `cmake.${key}`));
    context.subscriptions.push(register(key));
  }

  // Util for the special commands to forward to real commands
  function runCommand(key: keyof ExtensionManager, ...args: any[]) {
    return vscode.commands.executeCommand(`cmake.${key}`, ...args);
  }

  context.subscriptions.push(...[
      // Special commands that don't require logging or separate error handling
      vscode.commands.registerCommand('cmake.outline.configureAll', () => runCommand('configureAll')),
      vscode.commands.registerCommand('cmake.outline.buildAll', () => runCommand('buildAll')),
      vscode.commands.registerCommand('cmake.outline.stopAll', () => runCommand('stopAll')),
      vscode.commands.registerCommand('cmake.outline.cleanAll', () => runCommand('cleanAll')),
      vscode.commands.registerCommand('cmake.outline.cleanConfigureAll', () => runCommand('cleanConfigureAll')),
      vscode.commands.registerCommand('cmake.outline.cleanRebuildAll', () => runCommand('cleanRebuildAll')),
      // Commands for outline items:
      vscode.commands.registerCommand('cmake.outline.buildTarget',
                                      (what: TargetNode) => runCommand('build', what.folder, what.name)),
      vscode.commands.registerCommand('cmake.outline.runUtilityTarget',
                                      (what: TargetNode) => runCommand('cleanRebuild', what.folder)),
      vscode.commands.registerCommand('cmake.outline.debugTarget',
                                      (what: TargetNode) => runCommand('debugTarget', what.folder, what.name)),
      vscode.commands.registerCommand('cmake.outline.launchTarget',
                                      (what: TargetNode) => runCommand('launchTarget', what.folder, what.name)),
      vscode.commands.registerCommand('cmake.outline.setDefaultTarget',
                                      (what: TargetNode) => runCommand('setDefaultTarget', what.folder, what.name)),
      vscode.commands.registerCommand('cmake.outline.setLaunchTarget',
                                      (what: TargetNode) => runCommand('selectLaunchTarget', what.folder, what.name)),
      vscode.commands.registerCommand('cmake.outline.revealInCMakeLists',
                                      (what: TargetNode) => what.openInCMakeLists()),
      vscode.commands.registerCommand('cmake.outline.compileFile',
                                      (what: SourceFileNode) => runCommand('compileFile', what.filePath)),
  ]);
}

class SchemaProvider implements vscode.TextDocumentContentProvider {
  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    console.assert(uri.path[0] === '/', "A preceeding slash is expected on schema uri path");
    const fileName: string = uri.path.substr(1);
    const locale: string = util.getLocaleId();
    let localizedFilePath: string = path.join(util.thisExtensionPath(), "dist/schema/", locale, fileName);
    const fileExists: boolean = await util.checkFileExists(localizedFilePath);
    if (!fileExists) {
      localizedFilePath = path.join(util.thisExtensionPath(), fileName);
    }
    return fs.readFile(localizedFilePath, "utf8");
  }
}

/**
 * Starts up the extension.
 * @param context The extension context
 * @returns A promise that will resolve when the extension is ready for use
 */
export async function activate(context: vscode.ExtensionContext) {
    // CMakeTools versions newer or equal to #1.2 should not coexist with older versions
    // because the publisher changed (from vector-of-bool into ms-vscode),
    // causing many undesired behaviors (duplicate operations, registrations for UI elements, etc...)
    const oldCMakeToolsExtension = vscode.extensions.getExtension('vector-of-bool.cmake-tools');
    if (oldCMakeToolsExtension) {
        await vscode.window.showWarningMessage(localize('uninstall.old.cmaketools', 'Please uninstall any older versions of the CMake Tools extension. It is now published by Microsoft starting with version 1.2.0.'));
    }

  // Register a protocol handler to serve localized schemas
  vscode.workspace.registerTextDocumentContentProvider('cmake-tools-schema', new SchemaProvider());
  vscode.commands.executeCommand("setContext", "inCMakeProject", true);

  await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize('cmake.tools.initializing', 'CMake Tools initializing...'),
        cancellable: false,
      },
      progress => setup(context, progress),
  );

  // TODO: Return the extension API
  // context.subscriptions.push(vscode.commands.registerCommand('cmake._extensionInstance', () => cmt));
}

// this method is called when your extension is deactivated
export async function deactivate() {
  log.debug(localize('deactivate.cmaketools', 'Deactivate CMakeTools'));
  if (_EXT_MANAGER) {
    await _EXT_MANAGER.asyncDispose();
  }
}
