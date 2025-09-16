

//
const vscode = acquireVsCodeApi();

//
document.addEventListener('DOMContentLoaded', function() {

    //
    initializeTabs();

    //
    initializeResizeHandle();

});

// Handle messages from the extension
window.addEventListener('message', event => {
    const message = event.data;
    
    switch (message.command) {
        case 'socketMessage':
            handleSocketMessage(message);
            break;
    }
});

function handleSocketMessage(message) {
    const { type, data, timestamp } = message;
    
    switch (type) {
        case 'connection':
            addLogMessage(`🔗 ${data}`, 'info');
            break;
        case 'disconnection':
            addLogMessage(`❌ ${data}`, 'warn');
            break;
        case 'message':
            if (typeof data === 'object' && data.clientId && data.message) {
                addLogMessage(`📨 Client ${data.clientId} (${data.clientAddress}): ${data.message}`, 'log');
            } else {
                const messageData = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                addLogMessage(`📨 Message: ${messageData}`, 'log');
            }
            break;
        case 'error':
            addLogMessage(`⚠️ ${data}`, 'error');
            break;
        default:
            addLogMessage(`📡 ${type}: ${JSON.stringify(data)}`, 'log');
    }
}

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
