
//
import * as vscode from 'vscode';

//
import * as net from 'node:net';
import * as fs from 'node:fs';

//
const ECHOBUG_SOCKET_PORT = 3333;

//handle activation
export function activate(context: vscode.ExtensionContext) {

    //start the socket server
    const socketServer = new EchoBugSocketServer();

    //
    const webviewViewProvider = new EchoBugWebviewViewProvider(context.extensionUri, socketServer);
    const webviewViewRegistration = vscode.window.registerWebviewViewProvider('echobugPanel', webviewViewProvider);

    //
    context.subscriptions.push(socketServer, webviewViewRegistration);

}

//handle deactivation
export function deactivate() {}

//create a type for each request
type Request = {

    //
    requestId: string, 
    correlationId: string,

    //
    firstTimestamp: string,
    lastTimestamp: string,
    
    //
    method: string,
    url: string,
    status: number,

    //
    duration: number,
    memory: number,

    //
    globals: any[],
    messages: any[],
    queries: any[],
    timeline: any[],
    counters: any[],

};

/**
 * Socket server for receiving messages
 */
class EchoBugSocketServer implements vscode.Disposable {

    //
    private server!: net.Server;

    //
    private requests: Map<string, Request> = new Map();

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
            console.log(`[EchoBug] Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
     
            //
            socket.on('data', (data) => {

                //
                console.log(`[EchoBug] Received from client (${socket.remoteAddress}:${socket.remotePort}):`, data.toString().trim());

                //
                Array.from(JSON.parse(data.toString().trim())).forEach((item: any) => {

                    //
                    const { requestId, correlationId, timestamp, type, ...values } = item;

                    //
                    const request: Request = this.requests.get(requestId) || {} as Request;

                    //
                    request.requestId = requestId;
                    request.correlationId = correlationId;

                    //we assuming we get messages in order so we can just update the first and last timestamp
                    request.firstTimestamp ||= timestamp;
                    request.lastTimestamp = timestamp;

                    //
                    switch (type) {

                        //
                        case 'request':

                            //
                            request.method = values.method || request.method;
                            request.url    = values.url    || request.url;
                            request.status = values.status || request.status;

                            //
                            request.duration = values.duration || request.duration;
                            request.memory   = values.memory   || request.memory;

                        break;

                        //
                        case 'global':
                            (request.globals = request.globals || []).push(values);
                        break;
    
                        //
                        case 'query':
                            (request.queries = request.queries || []).push(values);
                        break;

                        //
                        case 'timeline':
                            (request.timeline = request.timeline || []).push(values);
                        break;

                        //
                        case 'counter':
                            (request.counters = request.counters || []).push(values);
                        break;

                        //
                        default:
                            (request.messages = request.messages || []).push({ type, ...values });
                        break;

                    }

                    //
                    this.requests.set(requestId, request);

                    //
                    console.log(`[EchoBug] Request Handled:`, request);

                    //
                    this.sendToPanel('message', { request });

                });

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

        //set the webview in the socket server for message forwarding
        this._socketServer.setWebviewView(webviewView);

        //handle messages from the webview
        webviewView.webview.onDidReceiveMessage((message) => {
            // to be implemented
        });

    }

    //
    private _getHtmlForWebview(webview: vscode.Webview) {
        try {

            //
            let htmlContent = fs.readFileSync(vscode.Uri.joinPath(this._extensionUri, 'src', 'webview.html').fsPath, 'utf8');

            //
            htmlContent = htmlContent.replace('%%styleUri%%', webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'webview.css')).toString());
            htmlContent = htmlContent.replace('%%scriptUri%%', webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'webview.js')).toString());

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

}
