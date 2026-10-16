
//
import { html } from './html.js';
import { formatUrl, formatTimestamp, formatValue } from './format.js';
import { contextTableHtml, initializeContextTable } from './context.js';
import { initializeExceptions } from './exceptions.js';

//
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

//every top level view has the same layout, so everything for requests is looked up inside its own view
const requestsView = document.querySelector('.view[data-view="requests"]');

//
const requestsContainer = requestsView.querySelector('.requests');

//
const contextContainer  = requestsView.querySelector('.tab-content[data-tab="context"]');
const contextList       = contextContainer.querySelector('.context');
const messagesContainer = requestsView.querySelector('.tab-content[data-tab="messages"]');
const queriesContainer  = requestsView.querySelector('.tab-content[data-tab="queries"]');

//
let selectedRequestId = null;

//
let currentMessages = [];

//
let currentContext = null;

//
let contextFilter = '';

//
let currentQueries = [];

//requests that have arrived since the app loaded and haven't been looked at yet
const unreadRequests = new Set();

//when the selected request started (epoch microseconds), the zero point for message and query deltas
let currentRequestStart = null;

//
let queryFilter = '';

//sections of the context tab the user has collapsed - these stay collapsed when switching between requests
const collapsedContextSections = new Set();

//
const messageFilter = { type: 'all', text: '' };

//exceptions have their own view
initializeExceptions();

//
initializeNavigation();

//
initializeResizableSidebars();

//
initializeSidebar();

//
initializeTabs();

//
initializeMessageFilter();

//
initializeContextFilter();

//
initializeQueryFilter();

//listen for the request-received event - this needs to be in place before we ask for the existing requests so nothing is missed
listen('request-received', (event) => {

    //
    const { requestId } = event.payload;

    //
    invoke('get_request', { requestId }).then((request) => {

        //
        if (!request) return;

        //remove the waiting message
        requestsContainer.querySelector('.waiting')?.remove();

        //add the request to the sidebar, or update it if we already have it
        const existingRequest = requestsContainer.querySelector(`[data-request-id="${CSS.escape(requestId)}"]`);
        if (existingRequest) {
            existingRequest.outerHTML = createRequestHtml(request);
        } else {
            unreadRequests.add(requestId);
            requestsContainer.insertAdjacentHTML('beforeend', createRequestHtml(request));
            showUnreadRequests();
        }

        //if the user is looking at this request then show them what just arrived
        if (requestId === selectedRequestId) {
            loadRequest(requestId);
        }

    });

});

//get a list of all the requests so we can display them in the sidebar (this is called when we first load the webview, or when it is reloaded)
invoke('get_all_requests').then((data) => {

    //
    if (data.length === 0) {
        return;
    }

    //
    requestsContainer.querySelectorAll('.waiting, .request').forEach((element) => element.remove());
    requestsContainer.insertAdjacentHTML('beforeend', data.map((request) => createRequestHtml(request)).join(''));

    //
    const storedRequestId = localStorage.getItem('echobug-selected-request');
    if (storedRequestId && requestsContainer.querySelector(`[data-request-id="${CSS.escape(storedRequestId)}"]`)) {
        selectRequest(storedRequestId);
    }

});

//the settings window can change where we are listening, so keep the sidebar up to date
listen('server-status-changed', (event) => {
    showServerStatus(event.payload);
});

//
invoke('get_server_status').then(showServerStatus);

//
function showServerStatus(status) {

    //
    requestsContainer.querySelector('.error')?.remove();

    //let the user know if we were unable to start listening - nothing is ever going to arrive
    if (status.error) {
        requestsContainer.querySelector('.waiting')?.remove();
        requestsContainer.insertAdjacentHTML('beforeend', html`<div class="error">unable to listen on ${status.host}:${status.port}: ${status.error}</div>`);
        return;
    }

    //
    showWaiting();

}

//
function showWaiting() {
    if (!requestsContainer.querySelector('.request, .waiting, .error')) {
        requestsContainer.innerHTML = '<div class="waiting">waiting for your first request <span class="animated-ellipsis"></span></div>';
    }
}

//switches between the top level views - the app always starts on requests
function showView(name) {

    //
    if (!document.querySelector(`.view[data-view="${name}"]`)) {
        return;
    }

    //
    document.querySelectorAll('.app-nav .nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));

}

//how many requests are still to be looked at
function showUnreadRequests() {

    //
    const badge = document.querySelector('.app-nav .nav-item[data-view="requests"] .badge');
    badge.hidden = unreadRequests.size === 0;
    badge.textContent = unreadRequests.size || '';

}

//
function initializeNavigation() {

    //
    const nav = document.querySelector('.app-nav');

    //
    nav.querySelectorAll('.nav-item').forEach((item) => {
        item.addEventListener('click', function() {
            showView(this.dataset.view);
        });
    });

    //
    nav.querySelector('.open-settings').addEventListener('click', function() {
        invoke('open_settings');
    });

    //
    nav.querySelector('.open-payloads').addEventListener('click', function() {
        invoke('open_payloads');
    });

    //
    showView('requests');

}

//every view's sidebar can be resized - they all share the same width, so switching views doesn't move things around
function initializeResizableSidebars() {

    //
    let resizing = null;
    let startX = 0;
    let startWidth = 0;

    //
    const savedWidth = localStorage.getItem('echobug-sidebar-width');
    if (savedWidth) {
        document.documentElement.style.setProperty('--echobug-sidebar-width', savedWidth);
    }

    //
    document.querySelectorAll('.view .sidebar').forEach((sidebar) => {
        sidebar.querySelector('.resize-handle').addEventListener('mousedown', function(event) {

            //
            event.preventDefault();

            //
            resizing = sidebar;
            startX = event.clientX;
            startWidth = sidebar.offsetWidth;

            //
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

        });
    });

    //
    document.addEventListener('mousemove', function(event) {
        if (!resizing) return;

        //
        const deltaX = event.clientX - startX;
        const newWidth = Math.max(150, Math.min(startWidth + deltaX, window.innerWidth * 0.8));

        //
        document.documentElement.style.setProperty('--echobug-sidebar-width', newWidth + 'px');

    });

    //
    document.addEventListener('mouseup', function() {
        if (!resizing) return;

        //
        localStorage.setItem('echobug-sidebar-width', resizing.offsetWidth + 'px');

        //
        resizing = null;

        //
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

    });

}

//
function initializeSidebar() {

    //
    const sidebar = requestsView.querySelector('.sidebar');

    //
    sidebar.querySelector('.clear-requests').addEventListener('click', function() {
        invoke('clear_requests').then(() => {

            //
            requestsContainer.querySelectorAll('.request').forEach((request) => request.remove());

            //
            unreadRequests.clear();
            showUnreadRequests();

            //
            clearRequest();

            //
            showWaiting();

        });
    });

    //select an item in the sidebar
    sidebar.addEventListener('click', function(event) {

        //
        const request = event.target.closest('.request');
        if (!request) return;

        //
        const requestId = request.dataset.requestId;

        //
        if (event.target.classList.contains('remove')) {
            invoke('remove_request', { requestId }).then(() => {

                //
                request.remove();

                //
                unreadRequests.delete(requestId);
                showUnreadRequests();

                //
                if (requestId === selectedRequestId) {
                    clearRequest();
                }

            });
            return;
        }

        //
        selectRequest(requestId);

    });

}

//
function switchTab(tabName) {

    //
    const selectedTab = requestsView.querySelector(`.tab[data-tab="${tabName}"]`);
    const selectedContent = requestsView.querySelector(`.tab-content[data-tab="${tabName}"]`);

    //
    if (!selectedTab || !selectedContent || selectedTab.classList.contains('disabled')) {
        return;
    }

    //
    requestsView.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });

    //
    requestsView.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });

    //
    selectedTab.classList.add('active');
    selectedContent.classList.add('active');

}

//
function initializeTabs() {

    //
    requestsView.querySelector('.tabs .open-flamegraph').addEventListener('click', function() {
        if (selectedRequestId) {
            invoke('open_flamegraph', { requestId: selectedRequestId });
        }
    });

    //
    requestsView.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', function() {
            switchTab(this.getAttribute('data-tab'));
        });
    });
}

//
function initializeMessageFilter() {

    //
    const filter = messagesContainer.querySelector('.message-filter');

    //
    filter.querySelector('input').addEventListener('input', function() {
        messageFilter.text = this.value.trim().toLowerCase();
        renderMessages();
    });

    //
    filter.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', function() {

            //
            filter.querySelectorAll('button').forEach((other) => {
                other.classList.toggle('active', other === this);
            });

            //
            messageFilter.type = this.dataset.type;
            renderMessages();

        });
    });

}

//
function initializeContextFilter() {
    contextContainer.querySelector('.context-filter input').addEventListener('input', function() {
        contextFilter = this.value.trim().toLowerCase();
        renderContext();
    });
}

//
function initializeQueryFilter() {
    queriesContainer.querySelector('.query-filter input').addEventListener('input', function() {
        queryFilter = this.value.trim().toLowerCase();
        renderQueries();
    });
}

//
function createRequestHtml(request) {

    //
    const [ statusClass, statusText ] = formatStatus(request.status);

    //
    const [ path, url ] = formatUrl(request.url);

    //
    const timestamp = formatTimestamp(request.timestamp);

    //
    return html`
        <div class="request${request.requestId === selectedRequestId ? ' selected' : ''}${unreadRequests.has(request.requestId) ? ' unread' : ''}" data-request-id="${request.requestId}" style="order: ${parseInt(request.order, 10)};">
            <div>
                <span class="status" data-status="${statusClass}" title="${statusText}">${request.status ?? '···'}</span>
                <span class="path" title="${url ?? request.requestId}">${path ?? request.requestId}</span>
            </div>
            <div>
                <span class="method" data-method="${request.method}">${request.method}</span>
                <span class="time">${timestamp}</span>
            </div>
            <button class="remove">&times;</button>
        </div>
    `.toString();

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

    //messages can arrive before we have been told about the request itself
    if (status === null || status === undefined) {
        return [ 'pending', 'No status received yet' ];
    }

    //
    return [ `${Math.floor(status / 100)}xx`,  ((responseCode.hasOwnProperty(status)) ? `${status}: ${responseCode[status]}` : `Unknown Status Code: ${status}`) ];

}

//how long after the start of the request something happened - falls back to the clock time when the two can't be compared
function formatDelta(entry) {

    //
    if (currentRequestStart === null || entry.timestampReceived) {
        return formatTimestamp(entry.timestamp);
    }

    //
    const delta = entry.timestamp - currentRequestStart;

    //
    return html`<span class="sign">${delta < 0 ? '−' : '+'}</span>${formatDuration(Math.abs(delta))}`;

}

//
function selectRequest(requestId) {

    //
    requestsContainer.querySelectorAll('.request.selected').forEach(request => {
        request.classList.remove('selected');
    });

    //
    requestsContainer.querySelector(`[data-request-id="${CSS.escape(requestId)}"]`)?.classList.add('selected');

    //
    requestsContainer.querySelector(`[data-request-id="${CSS.escape(requestId)}"]`)?.classList.remove('unread');
    unreadRequests.delete(requestId);
    showUnreadRequests();

    //
    localStorage.setItem('echobug-selected-request', requestId);

    //
    selectedRequestId = requestId;

    //
    loadRequest(requestId);

}

//
function clearRequest() {

    //
    selectedRequestId = null;

    //
    currentMessages = [];

    //
    currentRequestStart = null;

    //
    localStorage.removeItem('echobug-selected-request');

    //
    switchTab('context');

    //
    [ 'messages', 'queries', 'timeline' ].forEach((tab) => {
        requestsView.querySelector(`.tabs .tab[data-tab="${tab}"]`).classList.add('disabled');
    });

    //
    requestsView.querySelector('.tabs .stats div[data-name="duration"]').innerHTML = '--';
    requestsView.querySelector('.tabs .stats div[data-name="memory"]').innerHTML = '--';

    //
    requestsView.querySelector('.tabs .open-flamegraph').hidden = true;

    //
    currentContext = null;
    contextList.innerHTML = '';
    messagesContainer.querySelector('.messages').innerHTML = '';
    currentQueries = [];
    queriesContainer.querySelector('.queries').innerHTML = '';

}

//
function loadRequest(requestId) {
    invoke('get_request', { requestId }).then((request) => {

        //the user may have moved on to another request while we were waiting
        if (!request || requestId !== selectedRequestId) {
            return;
        }

        //update the tabs so they reflect the current request state
        [ 'messages', 'queries', 'timeline' ].forEach((tab) => {

            //
            const tabElement = requestsView.querySelector(`.tabs .tab[data-tab="${tab}"]`);

            //if there are no items, make the tab inactive (this will also hide the badge)
            if (!request[`${tab}Count`]) {

                //
                if (tabElement.classList.contains('active')) {
                    switchTab('context');
                }

                //
                tabElement.classList.add('disabled');
                return;

            }

            //make the tab active
            tabElement.classList.remove('disabled');

            //add or update the badge
            tabElement.querySelector('.badge').textContent = request[`${tab}Count`];

        });

        //deltas on the messages and queries tabs are measured from when the request started
        currentRequestStart = request.startedAt ?? null;

        //update the duration and memory stats
        requestsView.querySelector('.tabs .stats div[data-name="duration"]').innerHTML = formatDuration(request.duration);
        requestsView.querySelector('.tabs .stats div[data-name="memory"]').innerHTML = formatMemory(request.memory);

        //only requests xdebug profiled have a cachegrind file to show
        const flamegraphButton = requestsView.querySelector('.tabs .open-flamegraph');
        flamegraphButton.hidden = !request.cachegrind;
        flamegraphButton.title = request.cachegrind ? `Flamegraph (${request.cachegrind})` : 'Flamegraph';

        //update the context
        renderContextTab(requestId);

        //update the messages
        renderMessagesTab(requestId);

        //update the queries
        renderQueriesTab(requestId);

    });
}

//convert a duration in microseconds to a more readable format
function formatDuration(duration) {

    //
    duration = parseInt(duration, 10);

    //
    if (isNaN(duration)) {
        return '--';
    }

    //
    if (duration < 1000) {
        return html`<span class="value">${duration}</span><span class="units">µs</span>`;
    }

    //
    if (duration < 1000000) {
        return html`<span class="value">${(duration / 1000).toFixed(2)}</span><span class="units">ms</span>`;
    }

    //
    return html`<span class="value">${(duration / 1000000).toFixed(2)}</span><span class="units">s</span>`;
}

//convert a memory in bytes to a more readable format
function formatMemory(memory) {

    //
    memory = parseInt(memory, 10);

    //
    if (isNaN(memory)) {
        return '--';
    }

    //
    if (memory < 1024) {
        return html`<span class="value">${memory}</span><span class="units">B</span>`;
    }

    //
    if (memory < 1048576) {
        return html`<span class="value">${(memory / 1024).toFixed(2)}</span><span class="units">KiB</span>`;
    }

    //
    return html`<span class="value">${(memory / 1048576).toFixed(2)}</span><span class="units">MiB</span>`;

}

//replace the items in a list, keeping any that the user had expanded open
function renderList(container, selector, keyAttribute, content) {

    //
    const open = new Set(Array.from(container.querySelectorAll(`${selector}[open]`)).map((item) => item.getAttribute(keyAttribute)));

    //
    container.innerHTML = content;

    //
    container.querySelectorAll(selector).forEach((item) => {
        if (open.has(item.getAttribute(keyAttribute))) {
            item.open = true;
        }
    });

}

//
async function renderContextTab(requestId) {

    //
    const context = await invoke('get_request_context', { requestId });

    //
    if (requestId !== selectedRequestId) {
        return;
    }

    //
    currentContext = context;

    //
    renderContext();

}

//
function renderContext() {

    //
    if (!currentContext || Object.keys(currentContext).length === 0) {
        contextList.innerHTML = '<div class="no-data">No context available</div>';
        return;
    }

    //
    const sortedContext = Object.entries(currentContext).sort(([, a], [, b]) => {
        return (a?.order || 999) - (b?.order || 999);
    });

    //
    const matches = (value) => formatValue(value).toLowerCase().includes(contextFilter);

    //
    const sections = sortedContext.map(([key, value]) => {

        //
        const values = value?.values;
        if (!values || typeof values !== 'object' || Object.keys(values).length === 0) {
            return null;
        }

        //searching for a section by name shows everything in it, otherwise only the rows that match
        const label = value.label || key;
        const rows = (contextFilter === '' || matches(label))
            ? Object.entries(values)
            : Object.entries(values).filter(([paramKey, paramValue]) => matches(paramKey) || matches(paramValue));

        //
        return { key, label, rows };

    }).filter((section) => section && section.rows.length > 0);

    //
    if (sections.length === 0) {
        contextList.innerHTML = html`<div class="no-data">No context matches "${contextFilter}"</div>`;
        return;
    }

    //
    contextList.innerHTML = contextTableHtml(sections).toString();

    //
    initializeContextTable(contextList, collapsedContextSections, contextFilter !== '');

}

//
function renderMessagesTab(requestId) {
    invoke('get_request_messages', { requestId }).then((messages) => {

        //
        if (requestId !== selectedRequestId) {
            return;
        }

        //
        currentMessages = messages || [];

        //
        renderMessages();

    });
}

//
function renderMessages() {

    //filter the messages base on the filters
    let messages = filterMessages(currentMessages);

    //format the messages - this will include syntax highlighting, and other formatting as appropriate
    messages = formatMessage(messages);

    //
    renderList(messagesContainer.querySelector('.messages'), '.message', 'data-message-order', messages.map((message) => {

        //not every message knows where it came from
        const location = [ message.file, message.line ].filter((part) => part !== null && part !== undefined).join(':');

        //
        if (typeof message.highlightedValue !== 'undefined') {
            return html`
                <details class="message" data-message-type="${message.type}" data-message-order="${message.order}">
                    <summary>
                        <div class="timestamp" title="${formatTimestamp(message.timestamp, true)}">${formatDelta(message)}</div>
                        <div class="arrow"><svg class="icon"><use href="#icon-arrow"></use></svg></div>
                        <div class="content">
                            <div class="label">${message.label || ''}</div>
                            <div class="value">${message.text}</div>
                        </div>
                        <div class="file">${location}</div>
                    </summary>
                    <div class="value" data-highlight="${message.highlightedType}">${message.highlightedValue}</div>
                </details>
            `;
        }

        //
        return html`
            <details class="message" data-message-type="${message.type}" data-message-order="${message.order}" data-disabled>
                <summary>
                    <div class="timestamp" title="${formatTimestamp(message.timestamp, true)}">${formatDelta(message)}</div>
                    <div class="arrow"><svg class="icon"><use href="#icon-arrow"></use></svg></div>
                    <div class="content">
                        <div class="label">${message.label || ''}</div>
                        <div class="value">${message.text}</div>
                    </div>
                    <div class="file">${location}</div>
                </summary>
            </details>
        `;

    }).join(''));

}

//
function renderQueriesTab(requestId) {
    invoke('get_request_queries', { requestId }).then((queries) => {

        //
        if (requestId !== selectedRequestId) {
            return;
        }

        //
        currentQueries = queries || [];

        //
        renderQueries();

    });
}

//
function renderQueries() {

    //
    const queriesList = queriesContainer.querySelector('.queries');

    //
    const queries = filterQueries(currentQueries);

    //
    if (queries.length === 0 && currentQueries.length > 0) {
        queriesList.innerHTML = html`<div class="no-data">No queries match "${queryFilter}"</div>`;
        return;
    }

    //
    renderList(queriesList, '.query', 'data-query-order', queries.map((query) => {

        //
        const sql = formatValue(query.query ?? '');

        //
        return html`
            <details class="query" data-query-type="${query.type}" data-query-order="${query.order}">
                <summary>
                    <div class="timestamp" title="${formatTimestamp(query.timestamp, true)}">${formatDelta(query)}</div>
                    <div class="arrow"><svg class="icon"><use href="#icon-arrow"></use></svg></div>
                    <div class="content">
                        <div class="query-text">${sql}</div>
                        <div class="query-stats">
                            <span class="rows">${query.rowsAffected || 0} rows</span>
                            <span class="duration">${formatDuration(query.duration || 0)}</span>
                            <span class="memory">${formatMemory(query.memory || 0)}</span>
                        </div>
                    </div>
                </summary>
                <div class="query-details">
                    <details class="query-section" open>
                        <summary>
                            <span class="section-title">Query</span>
                        </summary>
                        <div class="query-code" data-highlight="sql">${syntaxHighlightSql(sql)}</div>
                    </details>
                    ${query.parameters && Object.keys(query.parameters).length > 0 ? html`
                        <details class="query-section">
                            <summary>
                                <span class="section-title">Parameters</span>
                            </summary>
                            <div class="query-params">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Parameter</th>
                                            <th>Value</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${Object.entries(query.parameters).map(([key, value]) => html`
                                            <tr>
                                                <td>${key}</td>
                                                <td>${formatValue(value)}</td>
                                            </tr>
                                        `)}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    ` : ''}
                    ${Array.isArray(query.results) && query.results.length > 0 ? html`
                        <details class="query-section">
                            <summary>
                                <span class="section-title">Results (${query.results.length} rows)</span>
                            </summary>
                            <div class="query-results">
                                <table>
                                    <thead>
                                        <tr>
                                            ${Object.keys(query.results[0] || {}).map(key => html`<th>${key}</th>`)}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${query.results.map(row => html`
                                            <tr>
                                                ${Object.values(row || {}).map(value => html`<td>${formatValue(value)}</td>`)}
                                            </tr>
                                        `)}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    ` : ''}
                </div>
            </details>
        `;

    }).join(''));

}

//the sql and the parameters are searched - the results would match far too often to be useful
function filterQueries(queries) {

    //
    if (queryFilter === '') {
        return queries;
    }

    //
    const matches = (value) => formatValue(value).toLowerCase().includes(queryFilter);

    //
    return queries.filter((query) => {
        return matches(query.query ?? '') || Object.entries(query.parameters || {}).some(([key, value]) => matches(key) || matches(value));
    });

}

//
function filterMessages(messages) {
    return messages.filter((message) => {

        //
        if (messageFilter.type !== 'all' && message.type !== messageFilter.type) {
            return false;
        }

        //
        if (messageFilter.text === '') {
            return true;
        }

        //
        return [ message.label, message.value, message.file ].some((field) => {
            return field !== null && field !== undefined && formatValue(field).toLowerCase().includes(messageFilter.text);
        });

    });
}

//
function formatMessage(messages) {

    //
    const isJson = (value) => {
        try {
            const json = JSON.parse(value);
            return (typeof json === 'object' && json !== null);
        } catch (err) {
            return false;
        }
    }

    //
    return messages.map((message) => {

        //the value should be a string, but it may have been sent as raw json
        const formatted = { ...message, text: (typeof message.value === 'string' || message.value === undefined) ? (message.value ?? '') : formatValue(message.value) };

        //
        if (isJson(formatted.text)) {
            formatted.highlightedType = 'json';
            formatted.highlightedValue = syntaxHighlightJSON(formatted.text);
        }

        //
        return formatted;

    });

}

//
function syntaxHighlightJSON(json) {

    //
    json = JSON.stringify(JSON.parse(json), null, 4);

    //
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    //
    return { _isSafe: true, toString: () => json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g, function (match) {

        //
        let type = 'number';

        //
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                type = 'key';
            } else {
                type = 'string';
            }
        } else if (/true|false/.test(match)) {
            type = 'boolean';
        } else if (/null/.test(match)) {
            type = 'null';
        }

        //
        return `<span class="${type}">${match}</span>`;

    })};

}

//
function syntaxHighlightSql(sql) {

    //
    sql = sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    //add line breaks before the main keywords
    sql = sql.replace(/(\b(ALTER|CREATE|DELETE|DROP|FROM|FULL|GROUP|HAVING|INNER|INSERT|INTO|LEFT|LIMIT|OFFSET|ORDER|RIGHT|SELECT|SET|UPDATE|VALUES|WHERE)\b)/g, '\n$1');

    //time the initial new line
    sql = sql.trim();

    //
    const keywords = [
        'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CREATE', 'DELETE', 'DESC', 'DISTINCT',
        'DROP', 'ELSE', 'END', 'EXISTS', 'FROM', 'FULL', 'GROUP', 'HAVING', 'IN', 'INNER', 'INSERT', 'INTO',
        'IS', 'IS', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER',
        'RIGHT', 'SELECT', 'SET', 'THEN', 'UNION', 'UPDATE', 'VALUES', 'WHEN', 'WHERE',
    ];

    //highlight everything in a single pass so the markup we add is never mistaken for part of the query
    const pattern = new RegExp(`(--.*$|\\/\\*[\\s\\S]*?\\*\\/)|('[^']*'|"[^"]*")|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${keywords.join('|')})\\b`, 'gim');
    sql = sql.replace(pattern, (match, comment, string, number) => {
        const type = (comment) ? 'comment' : (string) ? 'string' : (number) ? 'number' : 'keyword';
        return `<span class="${type}">${match}</span>`;
    });

    //
    return { _isSafe: true, toString: () => sql };

}
