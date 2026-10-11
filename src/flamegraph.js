
//
import { TIME, MEMORY, decode, parse, leftHeavy, childrenOf } from './cachegrind.js';

//
const { invoke } = window.__TAURI__.core;

//
const toolbar     = document.querySelector('.flamegraph-toolbar');
const breadcrumbs = toolbar.querySelector('.breadcrumbs');
const totals      = toolbar.querySelector('.totals');
const view        = document.querySelector('.flamegraph-view');
const canvas      = view.querySelector('canvas');
const spacer      = view.querySelector('.spacer');
const status      = view.querySelector('.status');
const tooltip     = document.querySelector('.flamegraph-tooltip');
const context     = canvas.getContext('2d');

//
const requestId = new URLSearchParams(location.search).get('requestId');

//
const ROW_HEIGHT = 18;
const MIN_FRAME_WIDTH = 0.5;
const MIN_LABEL_WIDTH = 24;

//the options are remembered between app loads
let mode   = localStorage.getItem('echobug-flamegraph-mode') === 'left-heavy' ? 'left-heavy' : 'time-order';
let metric = localStorage.getItem('echobug-flamegraph-metric') === 'memory' ? MEMORY : TIME;

//the parsed profile, and the trees built from it - left heavy is only built when it's first shown
let profile = null;
const trees = {};

//the frames from the top of the tree down to the one shown full width, double clicking a frame adds to this
let focusPath = [];

//the part of the focused frame that is visible, in the current metric's units - zooming and panning change this
let visible = { start: 0, end: 0 };

//what was drawn last, by depth and left to right, so the frame under the mouse can be found quickly
let rows = [];

//
let hovered = null;
let drag = null;

//
const colors = new Map();
const isDark = window.matchMedia('(prefers-color-scheme: dark)');

//
toolbar.querySelector(`[data-mode="${mode}"]`).classList.add('active');
toolbar.querySelector(`[data-mode="${mode === 'time-order' ? 'left-heavy' : 'time-order'}"]`).classList.remove('active');
toolbar.querySelector(`[data-metric="${metric === MEMORY ? 'memory' : 'time'}"]`).classList.add('active');
toolbar.querySelector(`[data-metric="${metric === MEMORY ? 'time' : 'memory'}"]`).classList.remove('active');

//
load();

//the window title says which request this is, in case several are open
invoke('get_request', { requestId }).then((request) => {
    if (request?.url) {
        document.title = `echobug flamegraph - ${request.method ?? ''} ${request.url}`.replace(/\s+/g, ' ');
    }
});

//
toolbar.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', function() {

    //
    if (!profile || this.dataset.mode === mode) {
        return;
    }

    //
    mode = this.dataset.mode;
    localStorage.setItem('echobug-flamegraph-mode', mode);
    toolbar.querySelectorAll('[data-mode]').forEach((other) => other.classList.toggle('active', other === this));

    //keep focus on the same frames where the other tree has them
    focusPath = findPath(tree(), focusPath.map((node) => node.name));
    resetZoom();

}));

//
toolbar.querySelectorAll('[data-metric]').forEach((button) => button.addEventListener('click', function() {

    //
    const selected = this.dataset.metric === 'memory' ? MEMORY : TIME;
    if (!profile || selected === metric) {
        return;
    }

    //
    metric = selected;
    localStorage.setItem('echobug-flamegraph-metric', this.dataset.metric);
    toolbar.querySelectorAll('[data-metric]').forEach((other) => other.classList.toggle('active', other === this));

    //
    resetZoom();

}));

//
breadcrumbs.addEventListener('click', (event) => {

    //
    const crumb = event.target.closest('[data-depth]');
    if (crumb) {
        focus(focusPath.slice(0, Number(crumb.dataset.depth) + 1));
    }

});

//escape goes back up one level, or back out of a zoom
document.addEventListener('keydown', (event) => {

    //
    if (event.key !== 'Escape' || !profile) {
        return;
    }

    //
    const focused = focusPath.at(-1);
    if (visible.start !== 0 || visible.end !== focused.total[metric]) {
        resetZoom();
    } else if (focusPath.length > 1) {
        focus(focusPath.slice(0, -1));
    }

});

//double clicking a frame shows just that frame and what it called, double clicking the top frame goes back up
canvas.addEventListener('dblclick', (event) => {

    //
    const frame = frameAt(event);
    if (!frame) {
        return;
    }

    //
    if (frame.parent === null) {
        if (focusPath.length > 1) {
            focus(focusPath.slice(0, -1));
        }
        return;
    }

    //
    const path = [];
    for (let current = frame; current.parent !== null; current = current.parent) {
        path.unshift(current.node);
    }

    //
    focus([ ...focusPath, ...path ]);

});

//
canvas.addEventListener('mousedown', (event) => {
    if (event.button === 0) {
        drag = { x: event.clientX, start: visible.start, end: visible.end, moved: false };
    }
});

//
window.addEventListener('mouseup', () => {
    drag = null;
    canvas.classList.remove('dragging');
});

//
window.addEventListener('mousemove', (event) => {

    //dragging pans along the frame that is focused
    if (drag) {

        //
        const distance = event.clientX - drag.x;
        if (Math.abs(distance) > 2) {
            drag.moved = true;
            canvas.classList.add('dragging');
        }

        //
        if (drag.moved) {
            const units = distance * (drag.end - drag.start) / canvas.clientWidth;
            setVisible(drag.start - units, drag.end - units);
            hideTooltip();
            return;
        }

    }

    //
    const frame = event.target === canvas ? frameAt(event) : null;
    if (frame?.node !== hovered?.node) {
        hovered = frame;
        draw();
    }

    //
    if (frame) {
        showTooltip(frame, event);
    } else {
        hideTooltip();
    }

});

//
canvas.addEventListener('mouseleave', () => {

    //
    hideTooltip();

    //
    if (hovered) {
        hovered = null;
        draw();
    }

});

//ctrl (or cmd) and the wheel zooms around the mouse, a sideways scroll pans, anything else scrolls the rows
view.addEventListener('wheel', (event) => {

    //
    if (!profile) {
        return;
    }

    //
    const width = visible.end - visible.start;
    const pointer = visible.start + (event.offsetX / canvas.clientWidth) * width;

    //
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const scale = Math.exp(event.deltaY * 0.002);
        setVisible(pointer - (pointer - visible.start) * scale, pointer + (visible.end - pointer) * scale);
        return;
    }

    //
    const sideways = event.shiftKey ? event.deltaY : event.deltaX;
    if (sideways !== 0 && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
        event.preventDefault();
        const units = sideways * width / canvas.clientWidth;
        setVisible(visible.start + units, visible.end + units);
    }

}, { passive: false });

//
view.addEventListener('scroll', () => {
    hideTooltip();
    draw();
});

//
new ResizeObserver(() => draw()).observe(view);

//
isDark.addEventListener('change', () => {
    colors.clear();
    draw();
});

//
async function load() {

    //
    status.hidden = false;
    status.textContent = 'loading profile…';

    //
    try {

        //
        const buffer = await invoke('get_request_cachegrind', { requestId });
        const text = await decode(buffer);

        //
        profile = parse(text);
        trees['time-order'] = profile.root;
        delete trees['left-heavy'];

        //
        totals.textContent = `${formatTime(profile.summary[TIME])} · ${formatMemory(profile.summary[MEMORY])} peak`;

        //
        status.hidden = true;
        focus([ tree() ]);

    } catch (err) {

        //
        status.textContent = '';
        const message = document.createElement('div');
        message.textContent = String(err?.message ?? err);
        const retry = document.createElement('button');
        retry.textContent = 'Retry';
        retry.addEventListener('click', load);
        status.append(message, retry);

    }

}

//
function tree() {

    //
    if (mode === 'left-heavy') {
        trees['left-heavy'] ??= leftHeavy(trees['time-order']);
    }

    //
    return trees[mode];

}

//follows the names down the tree as far as they go - used to keep the focus when switching between modes
function findPath(root, names) {

    //
    const path = [ root ];

    //
    for (const name of names.slice(1)) {

        //
        const child = path.at(-1).children.find((node) => node.name === name);
        if (!child) {
            break;
        }

        //
        path.push(child);

    }

    //
    return path;

}

//
function focus(path) {

    //
    focusPath = path;
    view.scrollTop = 0;

    //
    renderBreadcrumbs();
    resetZoom();

}

//
function resetZoom() {

    //
    visible = { start: 0, end: focusPath.at(-1).total[metric] };

    //
    renderBreadcrumbs();
    draw();

}

//zooming and panning stay within the focused frame
function setVisible(start, end) {

    //
    const total = focusPath.at(-1).total[metric];
    const width = Math.min(total, Math.max(end - start, total / 1e6));
    const clampedStart = Math.min(Math.max(0, start), total - width);

    //
    visible = { start: clampedStart, end: clampedStart + width };
    draw();

}

//
function renderBreadcrumbs() {

    //
    breadcrumbs.innerHTML = '';

    //
    focusPath.forEach((node, depth) => {

        //
        const crumb = document.createElement('button');
        crumb.dataset.depth = depth;
        crumb.textContent = depth === 0 ? 'All' : label(node.name);
        crumb.title = node.name;
        crumb.classList.toggle('active', depth === focusPath.length - 1);

        //
        breadcrumbs.append(crumb);

    });

    //the deepest frame is the interesting one
    breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;

}

//
function draw() {

    //
    const width = view.clientWidth;
    const height = view.clientHeight;
    const ratio = window.devicePixelRatio || 1;

    //
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
    }

    //
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    rows = [];

    //
    if (!profile) {
        return;
    }

    //
    const focused = focusPath.at(-1);
    if (focused.total[metric] <= 0) {
        spacer.style.height = '0px';
        status.hidden = false;
        status.textContent = `nothing was recorded for ${metric === MEMORY ? 'memory' : 'time'} here`;
        return;
    }

    //
    status.hidden = true;

    //
    layout(focused, 0, width / (visible.end - visible.start), width);

    //the canvas stays put while the rows scroll past it, the spacer gives the view something to scroll
    spacer.style.height = `${Math.max(0, (rows.length + 1) * ROW_HEIGHT - height)}px`;

    //
    const style = getComputedStyle(document.body);
    const font = `${style.getPropertyValue('--echobug-font-size').trim() || '12px'} ${style.getPropertyValue('--echobug-font-family')}`;
    const background = style.getPropertyValue('--echobug-editor-background');
    const outline = style.getPropertyValue('--echobug-focusBorder');

    //
    context.font = font;
    context.textBaseline = 'middle';

    //
    const ellipsisWidth = context.measureText('…').width;
    const scrollTop = view.scrollTop;
    const firstRow = Math.floor(scrollTop / ROW_HEIGHT);
    const lastRow = Math.min(rows.length - 1, Math.ceil((scrollTop + height) / ROW_HEIGHT));

    //
    for (let depth = firstRow; depth <= lastRow; depth++) {

        //
        const y = depth * ROW_HEIGHT - scrollTop;

        //
        for (const frame of rows[depth]) {

            //
            const x = Math.max(0, frame.x);
            const frameWidth = Math.min(width, frame.x + frame.width) - x;
            const color = colorOf(frame.node.name);

            //
            context.fillStyle = color.background;
            context.fillRect(x, y, Math.max(frameWidth - 1, 0.5), ROW_HEIGHT - 1);

            //
            if (frameWidth < MIN_LABEL_WIDTH) {
                continue;
            }

            //
            context.fillStyle = color.foreground;
            context.fillText(fit(label(frame.node.name), frameWidth - 8, ellipsisWidth), x + 4, y + ROW_HEIGHT / 2);

        }

    }

    //the frames were laid out again, so find where the hovered one ended up
    const outlined = hovered && rows[hovered.depth]?.find((frame) => frame.node === hovered.node);
    if (outlined) {
        const x = Math.max(0, outlined.x);
        const frameWidth = Math.min(width, outlined.x + outlined.width) - x;
        context.strokeStyle = outline || background;
        context.lineWidth = 1;
        context.strokeRect(x + 0.5, outlined.depth * ROW_HEIGHT - scrollTop + 0.5, Math.max(frameWidth - 2, 1), ROW_HEIGHT - 2);
    }

}

//works out where every visible frame goes - children start where the previous one ended, so in time order they
//appear in the order they were called
function layout(node, start, scale, width, depth = 0, parent = null) {

    //
    const x = (start - visible.start) * scale;
    const frameWidth = node.total[metric] * scale;

    //too small to see, or scrolled out of view
    if (frameWidth < MIN_FRAME_WIDTH || x + frameWidth < 0 || x > width) {
        return;
    }

    //
    const frame = { node, x, width: frameWidth, depth, parent };
    (rows[depth] ??= []).push(frame);

    //
    let offset = start;
    for (const child of childrenOf(node, metric)) {
        layout(child, offset, scale, width, depth + 1, frame);
        offset += child.total[metric];
    }

}

//frames in a row are left to right, so the one under the mouse can be found with a binary search
function frameAt(event) {

    //
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const row = rows[Math.floor((event.clientY - rect.top + view.scrollTop) / ROW_HEIGHT)];

    //
    if (!row) {
        return null;
    }

    //
    let low = 0;
    let high = row.length - 1;

    //
    while (low <= high) {

        //
        const middle = (low + high) >> 1;
        const frame = row[middle];

        //
        if (x < frame.x) {
            high = middle - 1;
        } else if (x >= frame.x + frame.width) {
            low = middle + 1;
        } else {
            return frame;
        }

    }

    //
    return null;

}

//
function showTooltip(frame, event) {

    //
    const node = frame.node;
    const focused = focusPath.at(-1);
    const percent = (value, of) => of > 0 ? ` (${(value / of * 100).toFixed(1)}%)` : '';

    //
    tooltip.innerHTML = '';
    tooltip.append(
        line('name', node.name),
        line('location', node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : ''),
        line('stat', `Time ${formatTime(node.total[TIME])}${percent(node.total[TIME], focused.total[TIME])} · self ${formatTime(node.self[TIME])}`),
        line('stat', `Memory ${formatMemory(node.total[MEMORY])}${percent(node.total[MEMORY], focused.total[MEMORY])} · self ${formatMemory(node.self[MEMORY])}`),
        line('stat', node.calls > 1 ? `${node.calls.toLocaleString()} calls` : ''),
    );
    tooltip.hidden = false;

    //keep it on screen, flipping to the other side of the mouse when it would go off the edge
    const left = event.clientX + 12 + tooltip.offsetWidth > window.innerWidth ? event.clientX - 12 - tooltip.offsetWidth : event.clientX + 12;
    const top = event.clientY + 16 + tooltip.offsetHeight > window.innerHeight ? event.clientY - 8 - tooltip.offsetHeight : event.clientY + 16;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = `${Math.max(0, top)}px`;

    //
    function line(className, text) {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = text;
        element.hidden = !text;
        return element;
    }

}

//
function hideTooltip() {
    tooltip.hidden = true;
}

//closures and includes carry a full path, the file name is enough to tell them apart on a frame
function label(name) {
    return name
        .replace(/\{closure:(?:[^{}]*\/)?([^/{}]+)\}/g, '{closure:$1}')
        .replace(/^((?:include|require)(?:_once)?)::.*\/([^/]+)$/, '$1::$2');
}

//
function fit(text, width, ellipsisWidth) {

    //
    if (context.measureText(text).width <= width) {
        return text;
    }

    //
    let low = 0;
    let high = text.length;

    //
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (context.measureText(text.slice(0, middle)).width + ellipsisWidth <= width) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    //
    return low === 0 ? '' : text.slice(0, low) + '…';

}

//frames from the same class (or namespace, for functions) share a colour, php's own functions are grey
function colorOf(name) {

    //
    let color = colors.get(name);
    if (color) {
        return color;
    }

    //
    const dark = isDark.matches;
    const group = groupOf(name);

    //
    if (group === null) {
        color = dark ? { background: 'hsl(0 0% 32%)', foreground: '#e0e0e0' } : { background: 'hsl(0 0% 84%)', foreground: '#333333' };
    } else {
        let hash = 0;
        for (let index = 0; index < group.length; index++) {
            hash = (hash * 31 + group.charCodeAt(index)) | 0;
        }
        const hue = Math.abs(hash) % 360;
        color = dark ? { background: `hsl(${hue} 45% 34%)`, foreground: '#f0f0f0' } : { background: `hsl(${hue} 70% 80%)`, foreground: '#222222' };
    }

    //
    colors.set(name, color);
    return color;

}

//
function groupOf(name) {

    //
    if (name.startsWith('php::')) {
        return null;
    }

    //
    const method = name.search(/->|::/);
    if (method !== -1) {
        return name.slice(0, method);
    }

    //
    const namespace = name.lastIndexOf('\\');
    return namespace === -1 ? name : name.slice(0, namespace);

}

//nanoseconds
function formatTime(time) {

    //
    if (time >= 1e9) {
        return `${(time / 1e9).toFixed(2)} s`;
    }

    //
    if (time >= 1e6) {
        return `${(time / 1e6).toFixed(2)} ms`;
    }

    //
    if (time >= 1e3) {
        return `${(time / 1e3).toFixed(2)} µs`;
    }

    //
    return `${Math.round(time)} ns`;

}

//bytes
function formatMemory(memory) {

    //
    if (memory >= 1024 * 1024) {
        return `${(memory / 1024 / 1024).toFixed(2)} MiB`;
    }

    //
    if (memory >= 1024) {
        return `${(memory / 1024).toFixed(2)} KiB`;
    }

    //
    return `${memory} B`;

}
