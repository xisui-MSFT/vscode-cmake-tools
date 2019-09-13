/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as vscode from 'vscode';
import * as util from './util';
import TelemetryReporter from 'vscode-extension-telemetry';

interface IPackageInfo {
    name: string;
    version: string;
    aiKey: string;
}

let telemetryReporter: TelemetryReporter | null;

export function activate(context: vscode.ExtensionContext): void {
    try {
        telemetryReporter = createReporter();
        if (telemetryReporter) {
            context.subscriptions.push(telemetryReporter);
        }
    } catch (e) {
        // can't really do much about this
    }
}

export function deactivate(): void {
    if (telemetryReporter) {
        telemetryReporter.dispose();
    }
}

export function logEvent(eventName: string, properties?: { [key: string]: string }, measures?: { [key: string]: number }): void {
    if (telemetryReporter) {
        telemetryReporter.sendTelemetryEvent(eventName, properties, measures);
    }
}

function createReporter(): TelemetryReporter | null {
    const packageInfo: IPackageInfo = getPackageInfo();
    if (packageInfo && packageInfo.aiKey) {
        return new TelemetryReporter(packageInfo.name, packageInfo.version, packageInfo.aiKey);
    }
    return null;
}

function getPackageInfo(): IPackageInfo {
    const packageJSON: util.PackageJSON = util.thisExtensionPackage();
    return {
        name: `${packageJSON.publisher}.${packageJSON.name}`,
        version: packageJSON.version,
        aiKey: "AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217"
    };
}