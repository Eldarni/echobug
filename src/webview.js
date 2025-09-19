
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
document.addEventListener('DOMContentLoaded', function() {

    //
    initializeTabs();

    //
    initializeResizeHandle();

    //listen for messages from the extension and handle them
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
        document.dispatchEvent(new CustomEvent(`message:${event.type}`, { detail: { ...event.data } }));

    });

});

//
function initializeTabs() {

    // Tab switching functionality
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
function initializeResizeHandle() {

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

}

// Initialize panel
vscode.postMessage({
    command: 'ready'
});
