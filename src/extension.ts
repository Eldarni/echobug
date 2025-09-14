
//
import * as vscode from 'vscode';
import * as net from 'net';

//
const ECHOBUG_SOCKET_PORT = 3333;

//
export function activate(context: vscode.ExtensionContext) {

    //start the socket server
    const socketServer = new EchoBugSocketServer();

    //
    const webviewViewProvider = new EchoBugWebviewViewProvider(context.extensionUri, socketServer);
    const webviewViewRegistration = vscode.window.registerWebviewViewProvider('echobugPanel', webviewViewProvider);

    //
    context.subscriptions.push(socketServer, webviewViewRegistration);

}

/**
 * Socket server for receiving messages
 */
class EchoBugSocketServer implements vscode.Disposable {

    //
    private server!: net.Server;

    //
    private currentWebviewView: vscode.WebviewView | undefined;

    //
    constructor() {
        this.startServer();
    }

    //
    private startServer() {
        this.server = net.createServer((socket) => {

            //
            const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
            
            //
            console.log(`[EchoBug] Client connected from ${clientAddress}`);

            //
            this.sendToPanel('connection', `Client connected from ${clientAddress}`);

            //
            socket.on('data', (data) => {
                const message = JSON.parse(data.toString().trim())
                console.log(`[EchoBug] Received from client:`, message);
                this.sendToPanel('message', { message });
            });

            //
            socket.on('error', (err) => {
                console.error(`[EchoBug] Socket error for client:`, err);
                this.sendToPanel('error', `Client error: ${err.message}`);
            });

            //
            socket.on('end', () => {
                console.log(`[EchoBug] Client disconnected`);
                this.sendToPanel('disconnection', `Client disconnected`);
            });

        });

        //
        this.server.on('error', (err) => {
            console.error('[EchoBug] Server error:', err);
            vscode.window.showErrorMessage(`EchoBug socket server error: ${err.message}`);
        });

        //
        this.server.listen(ECHOBUG_SOCKET_PORT, () => {
            console.log('[EchoBug] Socket server listening');
            vscode.window.showInformationMessage('EchoBug socket server started');
        });

    }

    //
    public setWebviewView(webviewView: vscode.WebviewView) {
        this.currentWebviewView = webviewView;
    }

    //
    private sendToPanel(type: string, data: any) {
        if (this.currentWebviewView) {
            this.currentWebviewView.webview.postMessage({
                command: 'socketMessage',
                type: type,
                data: data,
                timestamp: new Date().toISOString()
            });
        }
    }

    //
    public dispose() {
        if (this.server) {
            this.server.close();
            console.log('[EchoBug] Socket server closed');
        }
    }

}

/**
 * Webview view provider for the EchoBug panel
 */
class EchoBugWebviewViewProvider implements vscode.WebviewViewProvider {

    //
    public static readonly viewType = 'echobugPanel';

    //
    constructor(private readonly _extensionUri: vscode.Uri, private readonly _socketServer: EchoBugSocketServer) {}

    //
    public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {

        //
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'src')
            ]
        };

        //
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Set the webview in the socket server for message forwarding
        this._socketServer.setWebviewView(webviewView);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'ready':
                        this._sendStatusUpdate(webviewView, 'Extension is active and ready! Socket server running on port 3333', 'success');
                        break;
                }
            }
        );

    }

    //
    private _getHtmlForWebview(webview: vscode.Webview) {
        try {

            //
            const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview.html');

            //
            const htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

            //
            return htmlContent;

        } catch (error) {
            return `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>EchoBug Panel</title>
                </head>
                <body>
                    <h1>EchoBug Panel</h1>
                    <p>Error loading panel content. Please try refreshing.</p>
                </body>
                </html>
            `;
        }
    }

    //
    private _sendStatusUpdate(webviewView: vscode.WebviewView, text: string, type: 'success' | 'error' = 'success') {
        webviewView.webview.postMessage({
            command: 'updateStatus',
            text: text,
            type: type
        });
    }

}

// This method is called when your extension is deactivated
export function deactivate() {}
