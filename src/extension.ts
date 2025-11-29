
//
import * as vscode from 'vscode';

//
import * as net from 'node:net';
import * as fs from 'node:fs';

//
const extensionStartTime = Date.now();

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
    webviewViewProvider.registerRequestHandler('getAllRequests', async (payload: any) => {
        return Array.from(socketServer.requests.values()).map((request: Request) => {
            const { requestId, correlationId, method, url, status, timestamp, order, hidden } = request;
            if (hidden === false) {
                return { requestId, correlationId, method, url, status, timestamp, order };
            }
        }).filter((request: any) => request !== undefined);
    });

    //
    webviewViewProvider.registerRequestHandler('getRequest', async (payload: any) => {

        //
        const request = socketServer.requests.get(payload.requestId);
        if (!request) {
            return null;
        }

        //
        const { requestId, correlationId, method, url, status, timestamp, order, duration, memory } = request;

        //
        const messagesCount = request?.messages?.length;
        const queriesCount  = request?.queries?.length;
        const timelineCount = request?.timeline?.length;
        const countersCount = request?.counters?.length;

        //
        return { requestId, correlationId, method, url, status, timestamp, order, duration, memory, messagesCount, queriesCount, timelineCount, countersCount };

    });

    //
    webviewViewProvider.registerRequestHandler('getRequestContext', async (payload: any) => {
        const request = socketServer.requests.get(payload.requestId);
        return (request !== undefined) ? request?.context : null;
    });

    //
    webviewViewProvider.registerRequestHandler('getRequestMessages', async (payload: any) => {
        const request = socketServer.requests.get(payload.requestId);
        return (request !== undefined) ? request?.messages : null;
    });

    //
    webviewViewProvider.registerRequestHandler('getRequestQueries', async (payload: any) => {
        const request = socketServer.requests.get(payload.requestId);
        return (request !== undefined) ? request?.queries : null;
    });

    //
    webviewViewProvider.registerRequestHandler('removeRequest', async (payload: any) => {
        const request = socketServer.requests.get(payload.requestId);
        if (request) {
            socketServer.requests.set(request.requestId, { ...request, hidden: true });
        }
    });

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
    timestamp: number,

    //
    order: number,

    //
    method: string,
    url: string,
    status: number,

    //
    duration: number,
    memory: number,

    //
    context: { [key: string]: { label: string, order: number, value: { [key: string]: string } } },

    //
    messages: any[],
    queries: any[],
    timeline: any[],
    counters: any[],

    //
    hidden: boolean,

};

/**
 * Socket server for receiving messages
 */
class EchoBugSocketServer implements vscode.Disposable {

    //
    private server!: net.Server;

    //
    public requests: Map<string, Request> = new Map();

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
                try {

                    //
                    const now = Date.now();

                    //
                    const incoming = JSON.parse(data.toString().trim());
                    console.log(`[EchoBug] Received from client (${socket.remoteAddress}:${socket.remotePort}):`, incoming);

                    //
                    if (!incoming.requestId) {
                        console.warn('[EchoBug] Incoming request is missing requestId, skipping:', incoming);
                        return;
                    }

                    //
                    const existing: Request = this.requests.get(incoming.requestId) ?? {} as Request;

                    //
                    existing.requestId     ??= incoming.requestId;
                    existing.correlationId ??= incoming.correlationId;

                    //
                    if (!existing.timestamp) {
                        existing.timestamp = now;
                        existing.order     = now - extensionStartTime;
                    }

                    //
                    existing.method = incoming.method || existing.method || null;
                    existing.url    = incoming.url    || existing.url    || null;
                    existing.status = incoming.status || existing.status || null;

                    //
                    existing.duration = incoming.duration || existing.duration || null;
                    existing.memory   = incoming.memory   || existing.memory   || null;

                    //
                    existing.context ??= this.deepMerge(existing.context, incoming.context);

                    //
                    if (Array.isArray(existing.messages) && Array.isArray(incoming.messages)) {
                        existing.messages = [ ...existing.messages, ...incoming.messages ];
                    } else {
                        existing.messages ??= incoming.messages;
                    }

                    //
                    if (Array.isArray(existing.queries) && Array.isArray(incoming.queries)) {
                        existing.queries = [ ...existing.queries, ...incoming.queries ];
                    } else {
                        existing.queries ??= incoming.queries;
                    }

                    //
                    if (Array.isArray(existing.timeline) && Array.isArray(incoming.timeline)) {
                        existing.timeline = [ ...existing.timeline, ...incoming.timeline ];
                    } else {
                        existing.timeline ??= incoming.timeline;
                    }

                    //
                    if (Array.isArray(existing.counters) && Array.isArray(incoming.counters)) {
                        existing.counters = [ ...existing.counters, ...incoming.counters ];
                    } else {
                        existing.counters ??= incoming.counters;
                    }

                    //
                    this.requests.set(incoming.requestId, existing);

                    //
                    console.log(`[EchoBug] Request Handled:`, existing);

                    //
                    if (this.currentWebviewView) {
                        this.currentWebviewView.webview.postMessage({ type: 'request-received', data: { requestId: incoming.requestId } });
                    }

                } catch (err) {
                    console.error('[EchoBug] Failed handling incoming request:', err);
                }
            });

            //
            socket.on('error', (err) => {
                console.error(`[EchoBug] Socket error for client:`, err);
            });

            //
            socket.on('end', () => {
                console.log(`[EchoBug] Client disconnected`);
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
    private deepMerge(target: any, source: any): any {

        //
        if (source === null || source === undefined) {
            return target;
        }

        //
        if (Array.isArray(source)) {
            return source.slice();
        }

        //
        if (typeof source !== 'object') {
            return source;
        }

        //
        if (typeof target !== 'object' || target === null) {
            target = {};
        }

        //
        Object.keys(source).forEach((key) => {
            const sourceValue = source[key];
            const targetValue = target[key];

            //
            if (Array.isArray(sourceValue)) {
                target[key] = sourceValue.slice();
            } else if (sourceValue && typeof sourceValue === 'object') {
                target[key] = this.deepMerge(targetValue, sourceValue);
            } else if (sourceValue !== undefined) {
                target[key] = sourceValue;
            }
        });

        //
        return target;

    }

    //
    public setWebviewView(webviewView: vscode.WebviewView) {
        this.currentWebviewView = webviewView;
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
    private requestHandlers: Map<string, Function> = new Map();

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

        //
        webviewView.webview.onDidReceiveMessage(async (message) => {

            //
            const { id, command, payload } = message;

            //
            try {

                //
                const handler = this.requestHandlers.get(command);

                //
                if (!handler) {
                    throw new Error(`Handler for command '${command}' is not registered`);
                }

                //
                const result = await handler(payload);

                //
                webviewView.webview.postMessage({ id, result });

            } catch (error: any) {
                webviewView.webview.postMessage({ id, error: error.message });
            }

        });

    }

    //
    public registerRequestHandler(command: string, handler: Function) {
        this.requestHandlers.set(command, handler);
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
