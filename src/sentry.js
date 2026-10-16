
//
import { html } from './html.js';
import { contextTableHtml } from './context.js';

//renders a sentry event, as the sdk sent it, for the exceptions view
export function renderSentryEvent(event) {

    //
    const exceptions = [ ...(event.exception?.values ?? []) ].reverse();

    //
    return html`
        ${renderHeader(event, exceptions[0])}
        ${exceptions.map((exception, index) => renderException(exception, index === 0))}
        ${renderSection('Breadcrumbs', event.breadcrumbs?.values, renderBreadcrumbs)}
        ${renderContext(event)}
    `;

}

//what happened, and where and when it was sent from
function renderHeader(event, exception) {

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
        [ 'event', event.event_id ],
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

//a stack trace is shown newest frame first, with the frame that threw opened - vendor frames are muted, and hidden
//until the user asks for them, apart from the frame that threw which is always shown
function renderException(exception, isOutermost) {

    //
    const frames = [ ...(exception.stacktrace?.frames ?? []) ].reverse();

    //
    const root = projectRoot(frames);


    //
    return html`
        <details class="sentry-section exception" open>
            <summary>
                <span class="section-title">${isOutermost ? 'Exception' : 'Caused by'}</span>
                <span class="type">${exception.type}</span>
                <span class="value">${exception.value ?? ''}</span>
                ${exception.mechanism?.handled === false ? html`<span class="unhandled">unhandled</span>` : ''}
                ${frames.some(isVendor) ? html`<button class="toggle-vendor" title="Show or hide vendor frames">Vendor frames</button>` : ''}
            </summary>
            <div class="frames">
                ${frames.length === 0 ? html`<div class="no-data">No stack trace</div>` : ''}
                ${frames.map((frame, index) => renderFrame(frame, root, index === 0, isOutermost && index === 0))}
            </div>
        </details>
    `;

}

//
function renderFrame(frame, root, isThrower, isOpen) {

    //
    const path = framePath(frame);
    const file = (root && path.startsWith(root)) ? path.slice(root.length) : path;

    //
    const hasSource = typeof frame.context_line === 'string';
    const hasVars = frame.vars && Object.keys(frame.vars).length > 0;

    //
    return html`
        <details class="frame${isVendor(frame) ? ' vendor' : ''}${isThrower ? ' thrower' : ''}"${isOpen ? html` open` : ''}>
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

//everything sentry knows about where the event happened, shown the same way as a request's context - sections with
//nothing in them are left out
function renderContext(event) {

    //
    const sections = [
        [ 'tags', 'Tags', event.tags ],
        ...Object.entries(event.contexts ?? {}).map(([ name, context ]) => [ `context.${name}`, `Context · ${name}`, context ]),
        [ 'request', 'Request', event.request ],
        [ 'user', 'User', event.user ],
        [ 'extra', 'Extra', event.extra ],
        [ 'sdk', 'SDK', event.sdk ],
        [ 'modules', 'Modules', event.modules ],
    ].map(([ key, label, values ]) => ({ key, label, rows: Object.entries(values ?? {}) })).filter((section) => section.rows.length > 0);

    //
    return sections.length > 0 ? contextTableHtml(sections) : '';

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
function renderSection(title, content, renderContent) {

    //
    const count = Array.isArray(content) ? content.length : Object.keys(content ?? {}).length;

    //
    if (!content || count === 0) {
        return '';
    }

    //
    return html`
        <details class="sentry-section" open>
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
