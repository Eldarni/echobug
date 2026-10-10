
//
const { listen } = window.__TAURI__.event;

//
const list    = document.querySelector('.payload-list');
const count   = document.querySelector('.payload-toolbar .count');
const pretty  = document.querySelector('.payload-toolbar [data-action="pretty"]');
const wrap    = document.querySelector('.payload-toolbar [data-action="wrap"]');
const collapse = document.querySelector('.payload-toolbar [data-action="collapse"]');
const clear   = document.querySelector('.payload-toolbar [data-action="clear"]');

//only the most recent payloads are kept, a busy app would otherwise grow this window forever
const MAX_PAYLOADS = 500;

//
let received = 0;

//the options are remembered between app loads - pretty print and word wrap are on until the user turns them off
let isPretty = localStorage.getItem('echobug-payloads-pretty') !== 'false';
const isWrapped = localStorage.getItem('echobug-payloads-wrap') !== 'false';
let isCollapsed = localStorage.getItem('echobug-payloads-collapsed') === 'true';

//
pretty.classList.toggle('active', isPretty);
wrap.classList.toggle('active', isWrapped);
collapse.classList.toggle('active', isCollapsed);
document.body.classList.toggle('wrap', isWrapped);

//payloads only arrive while this window is open - nothing is kept from before it was opened
listen('payload-received', (event) => {

    //
    list.querySelector('.waiting')?.remove();

    //only follow new payloads if the user hasn't scrolled up to read an older one
    const isAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 8;

    //
    list.appendChild(createPayloadElement(event.payload));

    //
    while (list.children.length > MAX_PAYLOADS) {
        list.firstElementChild.remove();
    }

    //
    received++;
    count.textContent = `${received} payload${received === 1 ? '' : 's'}`;

    //
    if (isAtBottom) {
        list.scrollTop = list.scrollHeight;
    }

});

//
pretty.addEventListener('click', function() {

    //
    isPretty = !isPretty;
    this.classList.toggle('active', isPretty);
    localStorage.setItem('echobug-payloads-pretty', isPretty);

    //
    list.querySelectorAll('.payload pre').forEach((pre) => {
        pre.textContent = formatRaw(pre.dataset.raw);
    });

});

//
wrap.addEventListener('click', function() {

    //
    const isWrapped = document.body.classList.toggle('wrap');
    this.classList.toggle('active', isWrapped);
    localStorage.setItem('echobug-payloads-wrap', isWrapped);

});

//new payloads arrive collapsed while this is on, and the ones already shown follow along
collapse.addEventListener('click', function() {

    //
    isCollapsed = !isCollapsed;
    this.classList.toggle('active', isCollapsed);
    localStorage.setItem('echobug-payloads-collapsed', isCollapsed);

    //
    list.querySelectorAll('.payload').forEach((payload) => {
        payload.open = !isCollapsed;
    });

});

//
clear.addEventListener('click', function() {
    received = 0;
    count.textContent = '0 payloads';
    list.innerHTML = '<div class="waiting">waiting for payloads <span class="animated-ellipsis"></span></div>';
});

//
function createPayloadElement(payload) {

    //
    const element = document.createElement('details');
    element.className = 'payload';
    element.classList.toggle('error', Boolean(payload.error));
    element.open = !isCollapsed;

    //
    const header = document.createElement('summary');
    header.className = 'header';
    header.textContent = [ formatTime(payload.received), payload.client, formatSize(payload.raw), payload.error ].filter(Boolean).join(' · ');

    //the raw text is kept so it can be shown again when pretty printing is turned off
    const pre = document.createElement('pre');
    pre.dataset.raw = payload.raw;
    pre.textContent = formatRaw(payload.raw);

    //
    element.append(header, pre);
    return element;

}

//malformed payloads can't be pretty printed, so they are always shown as they arrived
function formatRaw(raw) {

    //
    if (!isPretty) {
        return raw;
    }

    //
    try {
        return JSON.stringify(JSON.parse(raw), null, 4);
    } catch (err) {
        return raw;
    }

}

//received is epoch microseconds
function formatTime(received) {
    return new Date(received / 1000).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 3 });
}

//
function formatSize(raw) {

    //
    const bytes = new TextEncoder().encode(raw).length;

    //
    return (bytes < 1024) ? `${bytes} B` : `${(bytes / 1024).toFixed(2)} KiB`;

}
