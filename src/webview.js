

//
const vscode = acquireVsCodeApi();

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
document.addEventListener('DOMContentLoaded', function() {

    //
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            switchTab(tabName);
        });
    });

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

// Initialize panel
vscode.postMessage({
    command: 'ready'
});
