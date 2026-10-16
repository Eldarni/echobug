
//
import { html } from './html.js';
import { formatUrl, formatTimestamp } from './format.js';
import { initializeContextTable } from './context.js';
import { renderSentryEvent } from './sentry.js';

//
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

//
const exceptionsView = document.querySelector('.view[data-view="exceptions"]');

//
const exceptionsContainer = exceptionsView.querySelector('.exceptions');
const detailContainer     = exceptionsView.querySelector('.exception-detail');

//
const badge = document.querySelector('.app-nav .nav-item[data-view="exceptions"] .badge');

//each source sends its own payload, and only its renderer knows how to show it
const renderers = {
    sentry: renderSentryEvent,
};

//
let selectedExceptionId = null;

//exceptions that have arrived since the app loaded and haven't been looked at yet
const unreadExceptions = new Set();

//sections of the context the user has collapsed - these stay collapsed when switching between exceptions, the sdk
//and modules are rarely interesting so they start collapsed
const collapsedContextSections = new Set([ 'sdk', 'modules' ]);

//
export function initializeExceptions() {

    //
    initializeSidebar();

    //
    initializeDetail();

    //this needs to be in place before we ask for the existing exceptions so nothing is missed
    listen('exception-received', (event) => {
        receiveException(event.payload.id);
    });

    //
    invoke('get_all_exceptions').then((exceptions) => {

        //the waiting message goes too - showWaiting puts it back if there is nothing to show
        exceptionsContainer.querySelectorAll('.waiting, .exception').forEach((element) => element.remove());
        exceptionsContainer.insertAdjacentHTML('beforeend', exceptions.map((exception) => createExceptionHtml(exception)).join(''));

        //
        showWaiting();

        //
        const storedExceptionId = parseInt(localStorage.getItem('echobug-selected-exception'), 10);
        if (exceptionsContainer.querySelector(`[data-exception-id="${storedExceptionId}"]`)) {
            selectException(storedExceptionId);
        }

    });

}

//how many exceptions are still to be looked at
function showUnreadExceptions() {
    badge.hidden = unreadExceptions.size === 0;
    badge.textContent = unreadExceptions.size || '';
}

//
function receiveException(id) {
    invoke('get_exception', { id }).then((exception) => {

        //
        if (!exception || exceptionsContainer.querySelector(`[data-exception-id="${id}"]`)) return;

        //
        exceptionsContainer.querySelector('.waiting')?.remove();

        //
        unreadExceptions.add(id);
        exceptionsContainer.insertAdjacentHTML('beforeend', createExceptionHtml(exception));
        showUnreadExceptions();

    });
}

//
function showWaiting() {
    if (!exceptionsContainer.querySelector('.exception, .waiting')) {
        exceptionsContainer.innerHTML = '<div class="waiting">no exceptions yet</div>';
    }
}

//
function initializeSidebar() {

    //
    const sidebar = exceptionsView.querySelector('.sidebar');

    //
    sidebar.querySelector('.clear-exceptions').addEventListener('click', function() {
        invoke('clear_exceptions').then(() => {

            //
            exceptionsContainer.querySelectorAll('.exception').forEach((exception) => exception.remove());

            //
            clearException();

            //
            unreadExceptions.clear();
            showUnreadExceptions();

            //
            showWaiting();

        });
    });

    //select an item in the sidebar
    exceptionsContainer.addEventListener('click', function(event) {

        //
        const exception = event.target.closest('.exception');
        if (!exception) return;

        //
        const id = parseInt(exception.dataset.exceptionId, 10);

        //
        if (event.target.classList.contains('remove')) {
            invoke('remove_exception', { id }).then(() => {

                //
                exception.remove();

                //
                unreadExceptions.delete(id);
                showUnreadExceptions();

                //
                if (id === selectedExceptionId) {
                    clearException();
                }

                //
                showWaiting();

            });
            return;
        }

        //
        selectException(id);

    });

}

//vendor frames are hidden until the user asks for them, and the choice is remembered between app loads - it is kept on
//the container so it carries over to every exception shown
function initializeDetail() {

    //
    detailContainer.classList.toggle('show-vendor', localStorage.getItem('echobug-vendor-frames') === 'true');

    //
    detailContainer.addEventListener('click', function(event) {

        //
        if (!event.target.closest('.toggle-vendor')) return;

        //the button sits inside the summary, so don't let it open or close the stack trace
        event.preventDefault();

        //
        localStorage.setItem('echobug-vendor-frames', this.classList.toggle('show-vendor'));

    });

}

//
function createExceptionHtml(exception) {

    //not every exception knows where it came from
    const location = [ exception.file, exception.line ].filter((part) => part !== null && part !== undefined).join(':');

    //whatever the source knew about the request it happened in
    const [ path, url ] = formatUrl(exception.url);

    //
    return html`
        <div class="exception${exception.id === selectedExceptionId ? ' selected' : ''}${unreadExceptions.has(exception.id) ? ' unread' : ''}" data-exception-id="${exception.id}" data-level="${exception.level}" style="order: ${parseInt(exception.id, 10)};">
            <div>
                ${exception.label ? html`<span class="label">${exception.label}</span>` : ''}
                <span class="value" title="${exception.value}">${exception.value}</span>
            </div>
            <div>
                <span class="location">${location}</span>
                <span class="time" title="${formatTimestamp(exception.timestamp, true)}">${formatTimestamp(exception.timestamp)}</span>
            </div>
            ${path ? html`
                <div>
                    ${exception.method ? html`<span class="method" data-method="${exception.method}">${exception.method}</span>` : ''}
                    <span class="path" title="${url}">${path}</span>
                </div>
            ` : ''}
            <button class="remove">&times;</button>
        </div>
    `.toString();

}

//
function selectException(id) {

    //
    exceptionsContainer.querySelectorAll('.exception.selected').forEach((exception) => {
        exception.classList.remove('selected');
    });

    //
    exceptionsContainer.querySelector(`[data-exception-id="${id}"]`)?.classList.add('selected');

    //
    exceptionsContainer.querySelector(`[data-exception-id="${id}"]`)?.classList.remove('unread');
    unreadExceptions.delete(id);
    showUnreadExceptions();

    //
    localStorage.setItem('echobug-selected-exception', id);

    //
    selectedExceptionId = id;

    //
    loadException(id);

}

//
function clearException() {

    //
    selectedExceptionId = null;

    //
    localStorage.removeItem('echobug-selected-exception');

    //
    detailContainer.innerHTML = '<div class="no-data">Select an exception to see its details</div>';

}

//
function loadException(id) {
    invoke('get_exception', { id }).then((exception) => {

        //the user may have moved on to another exception while we were waiting
        if (id !== selectedExceptionId) {
            return;
        }

        //
        if (!exception) {
            clearException();
            return;
        }

        //
        const render = renderers[exception.source];

        //a source without a renderer can still be looked at
        if (!render) {
            detailContainer.innerHTML = html`<pre class="raw">${JSON.stringify(exception.raw, null, 4)}</pre>`;
            return;
        }

        //
        detailContainer.innerHTML = render(exception.raw).toString();

        //
        initializeContextTable(detailContainer, collapsedContextSections);

    });
}
