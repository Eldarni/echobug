
//
const vscode = acquireVsCodeApi();

//
const pendingExtensionFetchRequests = new Map();

//
function extensionFetch(command, payload) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingExtensionFetchRequests.set(id, { resolve, reject });
        vscode.postMessage({ id, command, payload });
    });
}

//simple xss safe template literal - makes certain assumptions around the formatting - but it works for my use case
function html(strings, ...values) {

    //
    const escapeHTML = (str) => {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#x27;")
            .replace(/\//g, "&#x2F;");
    }

    //
    const escapeHTMLAttr = (str) => {
        return escapeHTML(str)
            .replace(/`/g, "&#x60;")
            .replace(/=/g, "&#x3D;");
    }

    //
    const escapeURL = (str) => {
        return encodeURIComponent(String(str));
    }

    //
    let result = '';

    //
    let inAttr = false;
    let currentAttrName = null;

    //
    for (let i = 0; i < strings.length; i++) {

        //
        result += strings[i];

        //scan chunk for entering/exiting attribute values
        for (let j = 0; j < strings[i].length; j++) {
            if (!inAttr) {
                const attrMatch = strings[i].slice(0, j+1).match(/([^\s=]+)\s*=\s*"$/);
                if (attrMatch) {
                    inAttr = true;
                    currentAttrName = attrMatch[1].toLowerCase();
                }
            } else {
                if (strings[i][j] === '"') {
                    inAttr = false;
                    currentAttrName = null;
                }
            }
        }

        //
        if (i < values.length) {
            if (inAttr) {
                if (['href', 'src'].includes(currentAttrName)) {
                    result += escapeURL(values[i]);
                } else {
                    result += escapeHTMLAttr(values[i]);
                }
            } else {
                result += escapeHTML(values[i]);
            }
        }
    }

    //
    return result;

}

//
const requestsContainer = document.querySelector('.requests');

//
document.addEventListener('DOMContentLoaded', function() {

    //
    initializeSidebar();

    //
    initializeTabs();

    //
    window.addEventListener('message', event => {

        //
        const { id, result, error } = event.data;

        //is this in response to a request we made?
        if (pendingExtensionFetchRequests.has(id)) {

            //
            const { resolve, reject } = pendingExtensionFetchRequests.get(id);

            //
            pendingExtensionFetchRequests.delete(id);

            //
            ((error) ? reject(error) : resolve(result));

            //
            return;

        }

        //nope, throw it at any event listeners that may be listening for it
        document.dispatchEvent(new CustomEvent(`message:${event.data.type}`, { detail: { ...event.data.data } }));

    });

    //get a list of all the requests so we can display them in the sidebar
    extensionFetch('getAllRequests').then((data) => {

        //
        requestsContainer.innerHTML = '';

        //
        if (data.length === 0) {
            requestsContainer.innerHTML = '<div class="waiting">waiting for your first request <span class="animated-ellipsis"></span></div>';
            return;
        }

        //
        data.sort((a, b) => new Date(b.firstTimestamp) - new Date(a.firstTimestamp));

        //
        data.forEach((request) => {
            requestsContainer.innerHTML += createRequestHtml(request);
        });

    });

    //listen for the request-received event
    document.addEventListener('message:request-received', function(event) {

        //remove the waiting message
        requestsContainer.querySelector('.waiting')?.remove();

        //prepend the new request to the top of the list
        extensionFetch('getRequest', { requestId: event.detail.requestId }).then((request) => {
            const existingRequest = requestsContainer.querySelector(`[data-request-id="${event.detail.requestId}"]`);
            if (existingRequest) {
                existingRequest.outerHTML = createRequestHtml(request);
            } else {
                requestsContainer.insertAdjacentHTML('afterbegin', createRequestHtml(request));
            }
        });

    });

});

//
function initializeSidebar() {

    //
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    //
    const sidebar = document.querySelector('.sidebar');
    const resizeHandle = document.querySelector('.resize-handle');

    //
    const savedWidth = localStorage.getItem('echobug-sidebar-width');
    if (savedWidth) {
        document.documentElement.style.setProperty('--echobug-sidebar-width', savedWidth);
    }

    //
    resizeHandle.addEventListener('mousedown', function(event) {

        //
        event.preventDefault();

        //
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;

        //
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

    });

    //
    document.addEventListener('mousemove', function(event) {
        if (!isResizing) return;

        //
        const deltaX = event.clientX - startX;
        const newWidth = Math.max(100, Math.min(startWidth + deltaX, window.innerWidth * 0.8));

        //
        sidebar.style.width = newWidth + 'px';
        document.documentElement.style.setProperty('--echobug-sidebar-width', newWidth + 'px');

    });

    //
    document.addEventListener('mouseup', function() {
        if (!isResizing) return;

        //
        isResizing = false;

        //
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        //
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            localStorage.setItem('echobug-sidebar-width', sidebar.offsetWidth + 'px');
        }

    });

    //select an item in the sidebar
    sidebar.addEventListener('click', function(event) {

        //
        const request = ((event.target.classList.contains('remove')) ? event.target : event.target.closest('.request'));
        if (!request) return;

        //
        if (event.target.classList.contains('remove')) {
            extensionFetch('removeRequest', { requestId: event.target.closest('.request').dataset.requestId }).then(() => {
                event.target.closest('.request').remove();
            });
            return;
        }

        //
        sidebar.querySelectorAll('.request.selected').forEach(request => {
            request.classList.remove('selected');
        });

        //
        request.classList.add('selected');

        //
        loadRequest(request.dataset.requestId);

    });

}

//
function initializeTabs() {

    //
    function switchTab(tabName) {

        //
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.remove('active');
        });

        //
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });

        //
        const selectedTab = document.querySelector(`[data-tab="${tabName}"]`);
        const selectedContent = document.querySelector(`.tab-content[data-tab="${tabName}"]`);

        //
        if (selectedTab && selectedContent) {
            selectedTab.classList.add('active');
            selectedContent.classList.add('active');
        }

    }

    //
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            switchTab(tabName);
        });
    });

}

//
function createRequestHtml(request) {

    //
    const [ statusClass, statusText ] = formatStatus(request.status);

    //
    const [ path, url ] = formatUrl(request.url)

    //
    const timestamp = formatTimestamp(request.firstTimestamp);

    //
    return html`
        <div class="request" data-request-id="${request.requestId}">
            <div>
                <span class="status" data-status="${statusClass}" title="${statusText}">${request.status}</span>
                <span class="path" title="${url}">${path}</span>
            </div>
            <div>
                <span class="method" data-method="${request.method}">${request.method}</span>
                <span class="time">${timestamp}</span>
            </div>
            <button class="remove">&times;</button>
        </div>
    `;

}

//
function formatStatus(status) {

    //
    const responseCode = {

        //
        100: 'Continue',
        101: 'Switching Protocols',
        102: 'Processing',
        103: 'Early Hints',

        //
        200: 'OK',
        201: 'Created',
        202: 'Accepted',
        204: 'No Content',
        206: 'Partial Content',
        226: 'IM Used',

        //
        300: 'Multiple Choices',
        301: 'Moved Permanently',
        302: 'Found',
        303: 'See Other',
        304: 'Not Modified',
        307: 'Temporary Redirect',
        308: 'Permanent Redirect',

        //
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        406: 'Not Acceptable',
        407: 'Proxy Authentication Required',
        408: 'Request Timeout',
        409: 'Conflict',
        410: 'Gone',
        411: 'Length Required',
        412: 'Precondition Failed',
        413: 'Payload Too Large',
        414: 'URI Too Long',
        415: 'Unsupported Media Type',
        416: 'Range Not Satisfiable',
        417: 'Expectation Failed',
        418: 'I\'m a teapot',
        421: 'Misdirected Request',
        422: 'Unprocessable Entity',
        425: 'Too Early',
        426: 'Upgrade Required',
        428: 'Precondition Required',
        429: 'Too Many Requests',
        431: 'Request Header Fields Too Large',
        451: 'Unavailable For Legal Reasons',

        //
        500: 'Internal Server Error',
        501: 'Not Implemented',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
        504: 'Gateway Timeout',
        505: 'HTTP Version Not Supported',
        506: 'Variant Also Negotiates',
        510: 'Not Extended',
        511: 'Network Authentication Required'

    }

    //
    return [ `${Math.floor(status / 100)}xx`,  ((responseCode.hasOwnProperty(status)) ? `${status}: ${responseCode[status]}` : `Unknown Status Code: ${status}`) ];

}

//
function formatUrl(url) {
    try {
        return [(new URL(url)).pathname, url];
    } catch (err) {
        return [url, url];
    }
}

//
function formatTimestamp(timestamp) {

    //
    const date = new Date(timestamp);

    //
    return date.toLocaleTimeString('en-GB', {
        hour12 : false,
        hour   : '2-digit',
        minute : '2-digit',
        second : '2-digit',
    });

}

//
function loadRequest(requestId) {
    extensionFetch('getRequest', { requestId }).then((data) => {
        console.log(data);
    });
}
