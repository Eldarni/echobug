
//
import { html } from './html.js';

//
const { invoke } = window.__TAURI__.core;

//
const view    = document.querySelector('.sentry-view');
const vendor  = document.querySelector('.sentry-toolbar [data-action="vendor"]');
const raw     = document.querySelector('.sentry-toolbar [data-action="raw"]');
const eventId = document.querySelector('.sentry-toolbar .event-id');

//the message is looked up by its request and its order within it
const params    = new URLSearchParams(location.search);
const requestId = params.get('requestId');
const order     = parseInt(params.get('order'), 10);

//the options are remembered between app loads - vendor frames are hidden until the user asks for them
let isShowingVendor = localStorage.getItem('echobug-sentry-vendor') === 'true';
let isShowingRaw = false;

//the whole sentry event, as the sdk sent it
let event = null;

//
vendor.classList.toggle('active', isShowingVendor);
document.body.classList.toggle('show-vendor', isShowingVendor);

//
vendor.addEventListener('click', function() {

    //
    isShowingVendor = document.body.classList.toggle('show-vendor');
    this.classList.toggle('active', isShowingVendor);
    localStorage.setItem('echobug-sentry-vendor', isShowingVendor);

});

//
raw.addEventListener('click', function() {

    //
    isShowingRaw = !isShowingRaw;
    this.classList.toggle('active', isShowingRaw);

    //
    render();

});

//
invoke('get_request_messages', { requestId }).then((messages) => {

    //
    const message = (messages || []).find((message) => message.order === order);

    //
    if (!message?.sentry) {
        view.innerHTML = html`<div class="status">the request no longer exists</div>`;
        return;
    }

    //
    event = message.sentry;
    eventId.textContent = event.event_id ?? '';

    //
    render();

}).catch((err) => {
    view.innerHTML = html`<div class="status error">${String(err)}</div>`;
});

//
function render() {

    //
    if (isShowingRaw) {
        view.innerHTML = html`<pre class="raw">${JSON.stringify(event, null, 4)}</pre>`;
        return;
    }

    //
    const exceptions = [ ...(event.exception?.values ?? []) ].reverse();

    //
    view.innerHTML = html`
        ${renderHeader(exceptions[0])}
        ${exceptions.map((exception, index) => renderException(exception, index === 0))}
        ${renderSection('Breadcrumbs', event.breadcrumbs?.values, renderBreadcrumbs)}
        ${renderSection('Tags', event.tags, renderTable)}
        ${Object.entries(event.contexts ?? {}).map(([ name, context ]) => renderSection(`Context · ${name}`, context, renderTable))}
        ${renderSection('Request', event.request, renderTable)}
        ${renderSection('User', event.user, renderTable)}
        ${renderSection('Extra', event.extra, renderTable)}
        ${renderSection('SDK', event.sdk, renderTable, false)}
        ${renderSection('Modules', event.modules, renderTable, false)}
    `.toString();

}

//what happened, and where and when it was sent from
function renderHeader(exception) {

    //sentry treats an event without a level as an error
    const level = event.level ?? 'error';

    //
    const message = typeof event.message === 'string' ? event.message : (event.message?.formatted ?? event.message?.message);

    //
    const details = [
        [ 'time', formatTime(event.timestamp) ],
        [ 'environment', event.environment ],
        [ 'release', event.release ],
        [ 'server', event.server_name ],
        [ 'transaction', event.transaction ],
        [ 'platform', event.platform ],
    ].filter(([ , value ]) => value !== undefined && value !== null && value !== '');

    //
    return html`
        <div class="sentry-header" data-level="${level}">
            <div class="title">
                <span class="level">${level}</span>
                ${exception ? html`<span class="type">${exception.type}</span>` : ''}
                <span class="value">${exception ? (exception.value ?? '') : (message ?? '')}</span>
            </div>
            ${exception && message ? html`<div class="message">${message}</div>` : ''}
            <div class="details">
                ${details.map(([ name, value ]) => html`<span><span class="name">${name}</span> ${value}</span>`)}
            </div>
        </div>
    `;

}

//a stack trace is shown newest frame first, with the frame that threw opened
function renderException(exception, isOutermost) {

    //
    const frames = [ ...(exception.stacktrace?.frames ?? []) ].reverse();

    //
    const root = projectRoot(frames);

    //
    const firstAppFrame = frames.find((frame) => !isVendor(frame));

    //
    return html`
        <details class="sentry-section exception" open>
            <summary>
                <span class="section-title">${isOutermost ? 'Exception' : 'Caused by'}</span>
                <span class="type">${exception.type}</span>
                <span class="value">${exception.value ?? ''}</span>
                ${exception.mechanism?.handled === false ? html`<span class="unhandled">unhandled</span>` : ''}
            </summary>
            <div class="frames">
                ${frames.length === 0 ? html`<div class="no-data">No stack trace</div>` : ''}
                ${frames.map((frame) => renderFrame(frame, root, frame === firstAppFrame))}
            </div>
        </details>
    `;

}

//
function renderFrame(frame, root, isOpen) {

    //
    const path = framePath(frame);
    const file = (root && path.startsWith(root)) ? path.slice(root.length) : path;

    //
    const hasSource = typeof frame.context_line === 'string';
    const hasVars = frame.vars && Object.keys(frame.vars).length > 0;

    //
    return html`
        <details class="frame${isVendor(frame) ? ' vendor' : ''}"${isOpen ? html` open` : ''}>
            <summary>
                <span class="location">${file}${frame.lineno ? `:${frame.lineno}` : ''}</span>
                <span class="function">${frame.function ?? ''}</span>
            </summary>
            ${hasSource ? renderSource(frame) : ''}
            ${hasVars ? html`<div class="vars">${renderTable(frame.vars)}</div>` : ''}
            ${!hasSource && !hasVars ? html`<div class="no-data">No source available</div>` : ''}
        </details>
    `;

}

//the lines around the one that was running, numbered from the frame's line
function renderSource(frame) {

    //
    const pre = frame.pre_context ?? [];
    const post = frame.post_context ?? [];
    const first = (frame.lineno ?? pre.length + 1) - pre.length;

    //
    const lines = [ ...pre, frame.context_line, ...post ];

    //
    return html`
        <table class="source">
            ${lines.map((line, index) => html`
                <tr${index === pre.length ? html` class="current"` : ''}>
                    <td class="number">${first + index}</td>
                    <td class="code">${line}</td>
                </tr>
            `)}
        </table>
    `;

}

//
function renderBreadcrumbs(breadcrumbs) {
    return html`
        <table class="breadcrumbs">
            ${breadcrumbs.map((breadcrumb) => html`
                <tr data-level="${breadcrumb.level ?? 'info'}">
                    <td class="time">${formatTime(breadcrumb.timestamp)}</td>
                    <td class="level">${breadcrumb.level ?? ''}</td>
                    <td class="category">${breadcrumb.category ?? breadcrumb.type ?? ''}</td>
                    <td class="message">
                        ${breadcrumb.message ?? ''}
                        ${breadcrumb.data ? html`<pre>${JSON.stringify(breadcrumb.data, null, 4)}</pre>` : ''}
                    </td>
                </tr>
            `)}
        </table>
    `;
}

//objects and arrays are shown as json, everything else as it is
function renderTable(values) {
    return html`
        <table class="values">
            ${Object.entries(values).map(([ key, value ]) => html`
                <tr>
                    <td>${key}</td>
                    <td>${(typeof value === 'object' && value !== null) ? html`<pre>${JSON.stringify(value, null, 4)}</pre>` : String(value)}</td>
                </tr>
            `)}
        </table>
    `;
}

//sections with nothing in them are left out
function renderSection(title, content, renderContent, isOpen = true) {

    //
    const count = Array.isArray(content) ? content.length : Object.keys(content ?? {}).length;

    //
    if (!content || count === 0) {
        return '';
    }

    //
    return html`
        <details class="sentry-section"${isOpen ? html` open` : ''}>
            <summary>
                <span class="section-title">${title}</span>
                <span class="count">${count}</span>
            </summary>
            ${renderContent(content)}
        </details>
    `;

}

//
function framePath(frame) {
    return frame.abs_path ?? frame.filename ?? '';
}

//stock sentry marks every frame as in app, so anything under vendor is treated as framework code too
function isVendor(frame) {
    return frame.in_app === false || /[\\/]vendor[\\/]/.test(framePath(frame));
}

//the project root is wherever vendor lives - paths are shown relative to it, like echobug's own messages
function projectRoot(frames) {

    //
    for (const frame of frames) {
        const index = framePath(frame).indexOf('/vendor/');
        if (index !== -1) {
            return framePath(frame).slice(0, index + 1);
        }
    }

    //
    return null;

}

//sentry timestamps are epoch seconds, shown in local time
function formatTime(seconds) {

    //
    if (typeof seconds !== 'number') {
        return seconds ?? '';
    }

    //
    const date = new Date(seconds * 1000);

    //
    return `${date.toLocaleDateString('en-GB')} ${date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}`;

}
